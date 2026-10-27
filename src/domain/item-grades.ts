// Item grades (issue #2845 part 5, design.md "Item grades"): the grade of a work item that ended done or failed, over
// every job of it — its parts, its runs again —, so the whole work of one issue is graded, not only each run. Its facts
// are its jobs' facts summed (`itemFactsOf`), graded with the same signals, weights and lines as a job's; its keys are its
// newest job's. A person may give an item a user grade of 1 to 5 with a note, its history kept. Pure: the grade pass
// folds the jobs' grades and keeps the rows.
import { autoGradeOf, type GradeFacts, type GradeRollupRow, type GradeRow, type GradeSettings, type UserGrade } from './grades.ts';
import type { WorkItem } from './work-items.ts';

/** The work item states an item grade judges. A dropped item was declined or dismissed: there is no work to judge. */
export const GRADED_ITEM_STATES = ['done', 'failed'] as const;
export type GradedItemState = (typeof GRADED_ITEM_STATES)[number];
export const gradedItemState = (state: string): state is GradedItemState => (GRADED_ITEM_STATES as readonly string[]).includes(state);

/**
 * An item's grade as kept: its source key, when it entered its end state (`endedAt`) and which, its newest job's keys,
 * each graded job with its automatic grade (oldest first), the summed facts, the automatic grade, and its user grade.
 */
export interface ItemGradeRow extends Pick<GradeRow, 'executor' | 'model' | 'repo' | 'kind' | 'machine' | 'auto' | 'gradedAt' | 'user'> {
  key: string; endedAt: string; state: GradedItemState; jobs: { jobId: string; score: number }[]; facts: GradeFacts;
}

const sum = (fs: readonly GradeFacts[], f: (x: GradeFacts) => number | undefined): number => fs.reduce((n, x) => n + (f(x) ?? 0), 0);

/**
 * An ended item's facts, from its jobs' grades: its outcome is the item's; its pull request the first one reverted, else
 * its newest job's; the checks fixed, rework, runs again, retries, reopens and fix issues summed; the cost summed when every
 * job has one; the times summed; the waste signals of every completion review.
 */
export function itemFactsOf(state: GradedItemState, rows: readonly GradeRow[]): GradeFacts {
  const fs = [...rows].sort((a, b) => a.endedAt.localeCompare(b.endedAt)).flatMap((r) => (r.facts ? [r.facts] : []));
  const prs = fs.flatMap((f) => (f.pullRequest ? [f.pullRequest] : []));
  const pr = prs.find((p) => p.reverted) ?? prs.at(-1);
  const reopens = sum(fs, (f) => f.reopens), fixIssues = sum(fs, (f) => f.fixIssues);
  const known = fs.length > 0 && fs.every((f) => f.costUsd !== undefined);
  const queue = fs.some((f) => f.queueMs !== undefined), wall = fs.some((f) => f.wallMs !== undefined);
  const reviewed = fs.filter((f) => f.waste !== undefined);
  return {
    status: state === 'failed' ? 'failed' : 'finished', ...(pr ? { pullRequest: pr } : {}),
    fixChecks: sum(fs, (f) => f.fixChecks), reworks: sum(fs, (f) => f.reworks), reruns: sum(fs, (f) => f.reruns),
    attempts: 1 + sum(fs, (f) => Math.max(0, f.attempts - 1)), ...(reopens > 0 ? { reopens } : {}), ...(fixIssues > 0 ? { fixIssues } : {}),
    ...(known ? { costUsd: Math.round(sum(fs, (f) => f.costUsd) * 1e6) / 1e6 } : {}),
    ...(queue ? { queueMs: sum(fs, (f) => f.queueMs) } : {}), ...(wall ? { wallMs: sum(fs, (f) => f.wallMs) } : {}),
    ...(reviewed.length > 0 ? { waste: [...new Set(reviewed.flatMap((f) => f.waste!))] } : {}),
  };
}

/** An ended item's grade from its jobs' grades, or undefined when none of its jobs is graded. */
export function itemGradeOf(
  item: Pick<WorkItem, 'key' | 'stateSince'> & { state: GradedItemState }, rows: readonly GradeRow[], settings: GradeSettings, now: Date,
): ItemGradeRow | undefined {
  const sorted = [...rows].sort((a, b) => a.endedAt.localeCompare(b.endedAt));
  const newest = sorted.at(-1);
  if (!newest) return undefined;
  const facts = itemFactsOf(item.state, sorted);
  return {
    key: item.key, endedAt: item.stateSince, state: item.state, executor: newest.executor, ...(newest.model ? { model: newest.model } : {}),
    ...(newest.repo ? { repo: newest.repo } : {}), kind: newest.kind, ...(newest.machine ? { machine: newest.machine } : {}),
    jobs: sorted.map((r) => ({ jobId: r.jobId, score: r.auto.score })), facts, auto: autoGradeOf(facts, settings), gradedAt: now.toISOString(),
  };
}

/** One item's grades. `grade`: absent until the grade pass graded it, or while it has not ended done or failed. */
export interface ItemGradeView { key: string; grade?: Omit<ItemGradeRow, 'user'>; user?: UserGrade; history: UserGrade[]; disagree?: boolean }

/** GET /api/grades/items: every group (its `jobs`: how many items), the sum of all, and the items, newest first. */
export interface ItemGradesView {
  by: string; total: Omit<GradeRollupRow, 'key'>; groups: GradeRollupRow[];
  items: {
    key: string; endedAt: string; state: GradedItemState; executor: string; model?: string; repo?: string; kind: string; machine?: string;
    jobs: number; auto: number; user?: number; disagree?: boolean;
  }[];
}
