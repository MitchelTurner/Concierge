import { getActiveProjects, type Project } from "./db.js";

export interface ScoredProject {
  project: Project;
  score: number;
}

export interface DayAllocation {
  /** Highest-scoring active fast (income) project, if any. */
  primary: ScoredProject | null;
  /** Highest-scoring active passive project, if any. Time-boxed to 30 min. */
  secondary: ScoredProject | null;
  /** Active projects with a deadline within 3 days (soonest first). */
  deadlineWarnings: Project[];
  /** True when there are no active fast projects at all. */
  noFastWork: boolean;
}

/**
 * Higher = do sooner.
 *   speed = 6 - time_to_cash  (invert: faster cash scores higher)
 *   score = (revenue_potential * confidence * speed) / max(effort_remaining, 1)
 */
export function score(p: Project): number {
  const speed = 6 - p.time_to_cash;
  return (p.revenue_potential * p.confidence * speed) / Math.max(p.effort_remaining, 1);
}

function scoreAndSort(projects: Project[]): ScoredProject[] {
  return projects
    .map((project) => ({ project, score: score(project) }))
    .sort((a, b) => b.score - a.score);
}

/** Number of whole days from today (UTC date) until the given ISO date. */
function daysUntil(isoDate: string): number | null {
  const target = new Date(isoDate);
  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();
  const t = Date.UTC(target.getFullYear(), target.getMonth(), target.getDate());
  const n = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((t - n) / 86_400_000);
}

/**
 * Dual-track allocation. Fast/income work is always the primary candidate;
 * passive work can never be promoted to primary while any fast project is
 * active. Deadlines within 3 days are surfaced regardless of score.
 */
export function allocateDay(projects: Project[] = getActiveProjects()): DayAllocation {
  const active = projects.filter((p) => p.status === "active");

  const fast = scoreAndSort(active.filter((p) => p.type === "fast"));
  const passive = scoreAndSort(active.filter((p) => p.type === "passive"));

  const deadlineWarnings = active
    .filter((p) => {
      if (!p.deadline) return false;
      const d = daysUntil(p.deadline);
      return d !== null && d <= 3;
    })
    .sort((a, b) => (daysUntil(a.deadline!) ?? 0) - (daysUntil(b.deadline!) ?? 0));

  return {
    primary: fast[0] ?? null,
    secondary: passive[0] ?? null,
    deadlineWarnings,
    noFastWork: fast.length === 0,
  };
}

export { daysUntil };
