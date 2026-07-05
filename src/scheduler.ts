/**
 * Per-user timezone scheduler.
 *
 * Fires every minute, compares each linked user's local time (IANA timezone)
 * against their daily_time / checkin_time, and sends nudges once per calendar
 * day (tracked via last_*_nudge_date on the user row).
 */
import cron, { type ScheduledTask } from "node-cron";
import {
  claimUserNudge,
  completeUserNudge,
  getUsersWithTelegram,
  releaseUserNudgeClaim,
  type User,
} from "./db.js";
import { runProactiveAlerts } from "./alerts.js";

export interface UserNudgeCallbacks {
  sendDaily: (user: User) => Promise<void>;
  sendCheckin: (user: User) => Promise<void>;
  sendWeekly: (user: User) => Promise<void>;
  sendAlert: (user: User, text: string) => Promise<void>;
}

/** Proactive alerts only fire during waking hours (local time). */
const ALERT_HOUR_MIN = 9;
const ALERT_HOUR_MAX = 20;

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Current local time ("HH:MM"), date, and weekday (0 = Sunday) in a user's timezone. */
function localTimeInTz(timezone: string): { time: string; date: string; weekday: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour").padStart(2, "0");
  const minute = get("minute").padStart(2, "0");
  const month = get("month");
  const day = get("day");
  const year = get("year");

  return {
    time: `${hour}:${minute}`,
    date: `${year}-${month}-${day}`,
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

function timesMatch(scheduled: string, current: string): boolean {
  return scheduled === current;
}

/**
 * Run every minute and deliver per-user daily nudges and evening check-ins
 * based on each user's timezone and schedule preferences.
 */
export function startUserScheduler(callbacks: UserNudgeCallbacks): ScheduledTask {
  const task = cron.schedule("* * * * *", () => {
    runUserNudges(callbacks).catch((err) => {
      console.error("[scheduler] per-user nudge tick failed:", err);
    });
  });

  console.log("[scheduler] per-user nudges running every minute (timezone-aware)");
  return task;
}

async function runUserNudges(callbacks: UserNudgeCallbacks): Promise<void> {
  const users = await getUsersWithTelegram();

  for (const user of users) {
    const { time, date, weekday } = localTimeInTz(user.timezone);

    if (
      timesMatch(user.daily_time, time) &&
      user.last_daily_nudge_date !== date
    ) {
      const claimed = await claimUserNudge(user.id, "daily", date);
      if (!claimed) continue;
      try {
        await callbacks.sendDaily(user);
        await completeUserNudge(user.id, "daily", date);
        console.log(`[scheduler] daily nudge sent to user #${user.id}`);
      } catch (err) {
        await releaseUserNudgeClaim(user.id, "daily", date);
        console.error(`[scheduler] daily nudge failed for user #${user.id}:`, err);
      }
    }

    if (
      timesMatch(user.checkin_time, time) &&
      user.last_checkin_nudge_date !== date
    ) {
      const claimed = await claimUserNudge(user.id, "checkin", date);
      if (!claimed) continue;
      try {
        await callbacks.sendCheckin(user);
        await completeUserNudge(user.id, "checkin", date);
        console.log(`[scheduler] check-in sent to user #${user.id}`);
      } catch (err) {
        await releaseUserNudgeClaim(user.id, "checkin", date);
        console.error(`[scheduler] check-in failed for user #${user.id}:`, err);
      }
    }

    // Proactive alerts: checked once an hour (minute :00) during waking hours.
    // Dedupe lives inside runProactiveAlerts (one-shot app_meta claims).
    const [hourStr, minuteStr] = time.split(":");
    const hour = Number(hourStr);
    if (minuteStr === "00" && hour >= ALERT_HOUR_MIN && hour <= ALERT_HOUR_MAX) {
      try {
        await runProactiveAlerts(user, callbacks.sendAlert);
      } catch (err) {
        console.error(`[scheduler] proactive alerts failed for user #${user.id}:`, err);
      }
    }

    if (
      weekday === user.weekly_review_day &&
      timesMatch(user.weekly_review_time, time) &&
      user.last_weekly_review_date !== date
    ) {
      const claimed = await claimUserNudge(user.id, "weekly", date);
      if (!claimed) continue;
      try {
        await callbacks.sendWeekly(user);
        await completeUserNudge(user.id, "weekly", date);
        console.log(`[scheduler] weekly review sent to user #${user.id}`);
      } catch (err) {
        await releaseUserNudgeClaim(user.id, "weekly", date);
        console.error(`[scheduler] weekly review failed for user #${user.id}:`, err);
      }
    }
  }
}
