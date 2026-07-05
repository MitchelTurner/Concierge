/**
 * Proactive alerts — event-driven pings outside the fixed morning/evening
 * schedule. Checked hourly (daytime only) by the scheduler:
 *
 *   - a project's deadline entered the 3-day warning window
 *   - an active project crossed the user's stall threshold
 *
 * Each alert fires exactly once per condition instance, deduped through
 * one-shot `app_meta` claims (per deadline value / per stall episode).
 */
import {
  claimOnce,
  getActiveProjects,
  getStalledProjects,
  releaseClaim,
  type User,
} from "./db.js";
import { daysSince, daysUntil } from "./scoring.js";

export type AlertSender = (user: User, text: string) => Promise<void>;

interface AlertCandidate {
  key: string;
  text: string;
}

async function collectAlerts(user: User): Promise<AlertCandidate[]> {
  const candidates: AlertCandidate[] = [];

  const active = await getActiveProjects(user.id);
  for (const p of active) {
    if (!p.deadline) continue;
    const days = daysUntil(p.deadline);
    if (days === null || days < 0 || days > 3) continue;
    const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
    candidates.push({
      key: `alert:deadline:${user.id}:${p.id}:${p.deadline}`,
      text: `\u23F0 Deadline: "${p.name}" (#${p.id}) is due ${when}.`,
    });
  }

  const stalled = await getStalledProjects(user.id, user.stall_days);
  for (const p of stalled) {
    // One alert per stall episode: the key includes the last progress stamp,
    // so making progress and stalling again re-arms the alert.
    const marker = p.last_progress_at ?? "never";
    const d = p.last_progress_at ? daysSince(p.last_progress_at) : null;
    candidates.push({
      key: `alert:stall:${user.id}:${p.id}:${marker}`,
      text:
        d !== null
          ? `\u26A0\uFE0F "${p.name}" (#${p.id}) is stalling — ${d} day${d === 1 ? "" : "s"} without progress. One small task gets it moving again.`
          : `\u26A0\uFE0F "${p.name}" (#${p.id}) has no recorded progress yet. Give it one concrete first task.`,
    });
  }

  return candidates;
}

/**
 * Check a user's alert conditions and send anything new as one batched
 * message. Claims are released if the send fails so the alert retries later.
 */
export async function runProactiveAlerts(user: User, send: AlertSender): Promise<void> {
  const candidates = await collectAlerts(user);
  if (candidates.length === 0) return;

  const claimed: AlertCandidate[] = [];
  for (const c of candidates) {
    if (await claimOnce(c.key)) claimed.push(c);
  }
  if (claimed.length === 0) return;

  try {
    await send(user, claimed.map((c) => c.text).join("\n\n"));
  } catch (err) {
    for (const c of claimed) {
      await releaseClaim(c.key);
    }
    throw err;
  }
}
