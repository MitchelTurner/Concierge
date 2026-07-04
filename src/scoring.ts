/**
 * Daily focus allocation for scored fast/passive projects.
 *
 * The app still supports project tasks, but the primary and secondary focus are
 * chosen from the scored project list so income work always wins over passive.
 */
import type { Project, ProjectTask, ProjectWithTasks } from "./db.js";

export interface FocusPick {
  project: Project;
  task: ProjectTask | null;
  action: string | null;
  score: number;
}

export interface DayAllocation {
  primary: FocusPick | null;
  secondary: FocusPick | null;
  openTaskCount: number;
  deadlineWarnings: Project[];
}

function openTasks(project: ProjectWithTasks): ProjectTask[] {
  return project.tasks.filter((t) => !t.done);
}

function nextOpenTask(project: ProjectWithTasks): ProjectTask | null {
  const pending = openTasks(project);
  return pending[0] ?? null;
}

function projectAction(project: ProjectWithTasks): string | null {
  const task = nextOpenTask(project);
  return task?.title ?? project.next_action ?? null;
}

function daysSince(isoDateTime: string): number | null {
  const past = new Date(isoDateTime);
  if (Number.isNaN(past.getTime())) return null;
  return Math.floor((Date.now() - past.getTime()) / 86_400_000);
}

export function scoreProject(project: Project): number {
  const speed = 6 - project.time_to_cash;
  return (
    (project.revenue_potential * project.confidence * Math.max(speed, 1)) /
    Math.max(project.effort_remaining, 1)
  );
}

export function daysUntil(dateText: string): number | null {
  const due = new Date(`${dateText}T00:00:00.000Z`);
  if (Number.isNaN(due.getTime())) return null;
  return Math.ceil((due.getTime() - Date.now()) / 86_400_000);
}

function isAllocatable(project: ProjectWithTasks): boolean {
  return project.status === "active" && Boolean(projectAction(project));
}

function rankProjects(projects: ProjectWithTasks[]): ProjectWithTasks[] {
  return [...projects].sort((a, b) => {
    const byScore = scoreProject(b) - scoreProject(a);
    if (byScore !== 0) return byScore;

    const aDeadline = a.deadline ? daysUntil(a.deadline) : null;
    const bDeadline = b.deadline ? daysUntil(b.deadline) : null;
    if (aDeadline !== null && bDeadline !== null && aDeadline !== bDeadline) {
      return aDeadline - bDeadline;
    }
    if (aDeadline !== null) return -1;
    if (bDeadline !== null) return 1;

    const aProgress = a.last_progress_at ? new Date(a.last_progress_at).getTime() : 0;
    const bProgress = b.last_progress_at ? new Date(b.last_progress_at).getTime() : 0;
    return bProgress - aProgress;
  });
}

function toPick(project: ProjectWithTasks | null): FocusPick | null {
  if (!project) return null;
  const task = nextOpenTask(project);
  return {
    project,
    task,
    action: task?.title ?? project.next_action ?? null,
    score: scoreProject(project),
  };
}

function deadlineWarnings(projects: ProjectWithTasks[]): Project[] {
  return projects
    .filter((project) => project.status === "active" && project.deadline)
    .filter((project) => {
      const days = daysUntil(project.deadline!);
      return days !== null && days >= 0 && days <= 3;
    })
    .sort((a, b) => (daysUntil(a.deadline!) ?? Infinity) - (daysUntil(b.deadline!) ?? Infinity));
}

export interface TimeboxItem {
  project: Project;
  /** Concrete task title (or the project's next_action fallback). */
  action: string;
  score: number;
}

export interface TimeboxPlan {
  minutes: number;
  items: TimeboxItem[];
  deadlineWarnings: Project[];
}

/** Minutes assumed per task when filling a time box. */
const MINUTES_PER_TASK = 30;

/**
 * Fill a block of available minutes with concrete tasks, income work first.
 * Roughly one task per 30 minutes; passive work only joins when there is at
 * least an hour and income tasks did not already fill the box.
 */
export function planTimebox(projects: ProjectWithTasks[], minutes: number): TimeboxPlan {
  const ranked = rankProjects(projects);
  const slots = Math.max(1, Math.floor(minutes / MINUTES_PER_TASK));
  const items: TimeboxItem[] = [];

  const fast = ranked.filter((p) => p.type === "fast" && isAllocatable(p));
  const passive = ranked.filter((p) => p.type === "passive" && isAllocatable(p));

  for (const project of fast) {
    if (items.length >= slots) break;
    const pending = openTasks(project);
    const actions = pending.length ? pending.map((t) => t.title) : [project.next_action!];
    for (const action of actions) {
      if (items.length >= slots) break;
      items.push({ project, action, score: scoreProject(project) });
    }
  }

  if (items.length < slots && minutes >= 60 && passive[0]) {
    const project = passive[0];
    const action = projectAction(project);
    if (action) items.push({ project, action, score: scoreProject(project) });
  }

  // Nothing income-ready: fall back to the best passive task so the time isn't wasted.
  if (items.length === 0 && passive[0]) {
    const project = passive[0];
    const action = projectAction(project);
    if (action) items.push({ project, action, score: scoreProject(project) });
  }

  return { minutes, items, deadlineWarnings: deadlineWarnings(projects) };
}

export function allocateDay(projects: ProjectWithTasks[]): DayAllocation {
  const ranked = rankProjects(projects);
  const openTaskCount = projects.reduce((n, p) => n + openTasks(p).length, 0);
  const fast = ranked.filter((project) => project.type === "fast" && isAllocatable(project));
  const passive = ranked.filter((project) => project.type === "passive" && isAllocatable(project));

  const primaryProject = fast[0] ?? null;
  const secondaryProject = passive[0] ?? null;

  return {
    primary: toPick(primaryProject),
    secondary: toPick(secondaryProject),
    openTaskCount,
    deadlineWarnings: deadlineWarnings(projects),
  };
}

export { daysSince };
