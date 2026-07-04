/**
 * Telegram message formatting for scored projects and tasks.
 */
import { allocateDay, daysSince, daysUntil, planTimebox, type DayAllocation } from "./scoring.js";
import {
  getAllProjectsWithTasks,
  getDailyLogSince,
  getStalledProjects,
  getTasksCompletedSince,
  type ProjectWithTasks,
} from "./db.js";

function stallLine(p: { id: number; name: string; last_progress_at: string | null }): string {
  if (!p.last_progress_at) {
    return `\u2022 ${p.name} (#${p.id}) — no recorded progress yet`;
  }
  const d = daysSince(p.last_progress_at) ?? 0;
  return `\u2022 ${p.name} (#${p.id}) — ${d} ${d === 1 ? "day" : "days"} since progress`;
}

export async function buildStallSection(
  userId: number,
  stallDays: number
): Promise<string | null> {
  const stalled = await getStalledProjects(userId, stallDays);
  if (stalled.length === 0) return null;

  const lines = ["\u26A0\uFE0F Stalling:"];
  for (const p of stalled) {
    lines.push(stallLine(p));
  }
  lines.push("Pick one small task and move an idea forward today.");
  return lines.join("\n");
}

export async function formatDailyMessage(
  userId: number,
  stallDays: number | null = null,
  allocation?: DayAllocation,
  projectsWithTasks?: ProjectWithTasks[]
): Promise<string> {
  const all = projectsWithTasks ?? (await getAllProjectsWithTasks(userId));
  const alloc = allocation ?? allocateDay(all);
  const lines: string[] = ["\u2600\uFE0F Today's focus", ""];

  if (alloc.deadlineWarnings.length > 0) {
    lines.push("\u23F0 Heads up:");
    for (const project of alloc.deadlineWarnings) {
      const days = daysUntil(project.deadline!);
      const suffix = days === 0 ? "today" : `in ${days}d`;
      lines.push(`\u2022 ${project.name} (#${project.id}) — due ${suffix}`);
    }
    lines.push("");
  }

  if (alloc.primary) {
    const { project, action, score } = alloc.primary;
    lines.push(`\uD83D\uDCB0 PRIMARY (income): ${project.name}`);
    lines.push(`\u2192 ${action ?? "Add a concrete next action."}`);
    lines.push(`Why: closest to getting paid (score ${score.toFixed(1)}).`);
  } else if (alloc.openTaskCount === 0) {
    lines.push("\uD83D\uDCB0 No fast projects have a next action.");
    lines.push("Capture a client-facing project or set a concrete next action before passive work.");
  } else {
    lines.push("\uD83D\uDCB0 No active fast projects are ready.");
    lines.push("Review your fast queue and set one concrete next action.");
  }

  if (alloc.secondary) {
    const { project, action } = alloc.secondary;
    lines.push("");
    lines.push(`\uD83C\uDF31 If you have 30 min spare: ${project.name}`);
    lines.push(`\u2192 ${action ?? "(add a next action)"}`);
    lines.push("Only do this after the primary income task.");
  }

  lines.push("");
  lines.push("Reply /done {id} when you finish something.");

  if (stallDays !== null) {
    const stallSection = await buildStallSection(userId, stallDays);
    if (stallSection) {
      lines.push("");
      lines.push(stallSection);
    }
  }

  return lines.join("\n");
}

/** Suggest what to do with a fixed block of free time, income work first. */
export async function formatTimeboxMessage(userId: number, minutes: number): Promise<string> {
  const all = await getAllProjectsWithTasks(userId);
  const plan = planTimebox(all, minutes);

  if (plan.items.length === 0) {
    return (
      `You have ${minutes} min but no active project has a next task.\n` +
      "Use /add to capture one, or add a task with /next {id} {task}."
    );
  }

  const lines: string[] = [`\u23F1\uFE0F ${minutes} min? Here's the best use of it:`, ""];
  plan.items.forEach((item, i) => {
    const tag = item.project.type === "fast" ? "\uD83D\uDCB0" : "\uD83C\uDF31";
    lines.push(`${i + 1}. ${tag} ${item.action}`);
    lines.push(`   (${item.project.name} #${item.project.id})`);
  });

  if (plan.deadlineWarnings.length > 0) {
    lines.push("");
    lines.push(
      `\u23F0 Deadlines soon: ${plan.deadlineWarnings
        .map((p) => `${p.name} (due ${p.deadline})`)
        .join("; ")}`
    );
  }

  lines.push("");
  lines.push("Reply /done {id} when you finish something.");
  return lines.join("\n");
}

/** Look back over the last 7 days and set up the week ahead. */
export async function formatWeeklyReview(userId: number, stallDays: number): Promise<string> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const completed = await getTasksCompletedSince(userId, since);
  const logs = await getDailyLogSince(userId, since);
  const all = await getAllProjectsWithTasks(userId);
  const alloc = allocateDay(all);

  const lines: string[] = ["\uD83D\uDCCA Weekly review", ""];

  if (completed.length > 0) {
    const byProject = new Map<string, number>();
    for (const t of completed) {
      byProject.set(t.project_name, (byProject.get(t.project_name) ?? 0) + 1);
    }
    lines.push(`\u2705 Shipped this week: ${completed.length} task${completed.length === 1 ? "" : "s"}`);
    for (const [name, count] of byProject) {
      lines.push(`\u2022 ${name} — ${count} done`);
    }
  } else {
    lines.push("\u2705 No tasks completed this week. Pick one small win to start the next one.");
  }

  if (logs.length > 0) {
    lines.push("");
    lines.push(`\uD83D\uDCDD Check-ins logged: ${logs.length} of 7 days`);
  }

  const stallSection = await buildStallSection(userId, stallDays);
  if (stallSection) {
    lines.push("");
    lines.push(stallSection);
  }

  lines.push("");
  if (alloc.primary) {
    const { project, action } = alloc.primary;
    lines.push(`\uD83C\uDFAF Next week's focus: ${project.name}`);
    lines.push(`\u2192 ${action ?? "Add a concrete next action."}`);
  } else {
    lines.push("\uD83C\uDFAF No fast project is ready for next week.");
    lines.push("Activate one income project and give it a concrete first task.");
  }

  return lines.join("\n");
}

export async function formatProjectList(userId: number): Promise<string> {
  const all = await getAllProjectsWithTasks(userId);
  const active = all.filter((p) => p.status === "active" || p.status === "idea");
  if (active.length === 0) {
    return "No projects yet. Use /add to capture one.";
  }
  return active
    .map((p) => {
      const open = p.tasks.filter((t) => !t.done).length;
      const done = p.tasks.filter((t) => t.done).length;
      const score = ((p.revenue_potential * p.confidence * Math.max(6 - p.time_to_cash, 1)) / Math.max(p.effort_remaining, 1)).toFixed(1);
      return `#${p.id} ${p.name} [${p.type}/${p.status}] — score ${score}, ${open} open, ${done} done`;
    })
    .join("\n");
}
