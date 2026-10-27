// Grades (issue #2845, design.md "Grades"): each ended job's **automatic grade** — a score of 0 to 100 from its grade
// signals, each a value of 0 to 1 with its weight and why, so the breakdown says how the score came about — and a person's
// **user grade** of 1 to 5 with a note, its history kept. A signal the job has no facts for is left out, and the score is
// the weighted mean of the rest. Grades roll up by executor, model, repository, work kind or machine,
// so it shows which setup does good work. Pure: the grade pass folds the facts and keeps the rows.
import type { DomainEvent, Job } from './types.ts';
import { machineOfLane } from './raised-by.ts';
import { workKindOf, type WorkKind } from './skill-library.ts';

export const GRADE_SIGNALS = ['outcome', 'checks', 'pull_request', 'rework', 'cost', 'time'] as const;
export type GradeSignal = (typeof GRADE_SIGNALS)[number];

/**
 * How the automatic grade weighs its signals: a weight of 0 leaves a signal out. `revertWindowDays`: a revert of a job's
 * pull request this long after its merge or sooner lowers its grade. `costScaleUsd` and `timeScaleMinutes`: the estimated
 * cost and the wall time that give half the cost and time signal. `routing`: grade-aware routing (`grade-routing.ts`), off
 * by default; `minSamples`, the graded jobs of matching work each executor needs before intake compares them.
 */
export interface GradeSettings {
  weights: Record<GradeSignal, number>; revertWindowDays: number; costScaleUsd: number; timeScaleMinutes: number;
  routing: { on: boolean; minSamples: number };
}

export const DEFAULT_GRADE_SETTINGS: GradeSettings = {
  weights: { outcome: 3, checks: 2, pull_request: 3, rework: 2, cost: 1, time: 1 }, revertWindowDays: 7, costScaleUsd: 5, timeScaleMinutes: 120,
  routing: { on: false, minSamples: 10 },
};

/** The revert of a job's merged pull request: when it merged, and its own pull request. */
export interface GradeRevert { at: string; url: string }

/**
 * What a job's grade is made from. `fixChecks`: the times tending ran its item again to fix failing checks; `reworks`: a
 * person sent its pull request back; `reruns`: its item ran again after it; `attempts`: its claims. `costUsd`: the token
 * ledger's estimated cost, when every model in it has a price. `queueMs`: from its queue to its start; `wallMs`: from its
 * start to its end.
 */
export interface GradeFacts {
  status: 'finished' | 'failed'; partlyDone?: true;
  pullRequest?: { url: string; state: 'open' | 'merged' | 'closed'; mergedAt?: string; reverted?: GradeRevert };
  fixChecks: number; reworks: number; reruns: number; attempts: number;
  costUsd?: number; queueMs?: number; wallMs?: number;
}

/** One signal of a grade: its value (0 to 1), its weight and why. */
export interface GradeLine { signal: GradeSignal; value: number; weight: number; why: string }
export interface AutoGrade { score: number; lines: GradeLine[] }

/** A person's grade of a job: 1 to 5, with a note. */
export interface UserGrade { score: number; note?: string; by: string; at: string }

export const GRADE_GROUPS = ['executor', 'model', 'repo', 'kind', 'machine'] as const;
export type GradeGroup = (typeof GRADE_GROUPS)[number];

/** A job's grade as kept: its keys, its facts and automatic grade, and its user grade, when a person gave one. */
export interface GradeRow {
  jobId: string; endedAt: string; executor: string; model?: string; repo?: string; kind: WorkKind; machine?: string;
  facts?: GradeFacts; auto: AutoGrade; gradedAt?: string; user?: UserGrade;
}

/** The kept grades and the user grades with their history (`GradeRepository`, `src/store/grades.ts`). */
export interface GradeRepository {
  cursor(): number | undefined;
  /** Keeps each row's keys and automatic grade (its user grade is kept apart), and the pass's cursor, in one transaction. */
  save(rows: GradeRow[], cursor?: number): void;
  get(jobId: string): GradeRow | undefined;
  list(q?: { since?: string; repo?: string; limit?: number }): GradeRow[];
  /** Adds a user grade to the job's history: the newest is its user grade. */
  grade(jobId: string, g: UserGrade): void;
  history(jobId: string): UserGrade[];
}

/** The events a grade is folded from: a job's end, its pull request and the rework it needed, and a landing batch's revert. */
export const GRADE_EVENTS = [
  'job.finished', 'job.failed', 'job.pull_request_followed', 'job.pull_request_merged', 'job.pull_request_closed',
  'job.pull_request_tended', 'job.rework_requested', 'job.rerun', 'landing_batch.revert_opened', 'landing_batch.reverted',
] as const;

/** A user grade's place on the automatic grade's scale: 1 is 0, 5 is 100. */
export const userPointsOf = (score: number): number => (score - 1) * 25;

/** How far apart the two grades are, at the least, to disagree. */
export const DISAGREE_POINTS = 40;
export const disagreesOf = (auto: number, user: number): boolean => Math.abs(auto - userPointsOf(user)) >= DISAGREE_POINTS;

/** The value that is half at `scale`. */
const halfAt = (x: number, scale: number): number => 1 / (1 + Math.max(0, x) / scale);
const minutes = (ms: number): string => `${Math.round(ms / 60_000)} min`;

function signalOf(signal: GradeSignal, f: GradeFacts, s: GradeSettings): { value: number; why: string } | undefined {
  const pr = f.pullRequest;
  switch (signal) {
    case 'outcome':
      if (f.status === 'failed') return { value: 0, why: 'failed' };
      return f.partlyDone ? { value: 0.75, why: 'finished partly done' } : { value: 1, why: 'finished' };
    case 'checks':
      if (pr?.state === 'merged') return f.fixChecks === 0 ? { value: 1, why: 'merged with its checks passed' } : { value: 0.5, why: `merged after ${f.fixChecks} fix of failing checks` };
      return f.fixChecks > 0 ? { value: 0, why: `failing checks, ${f.fixChecks} fix, not merged` } : undefined;
    case 'pull_request':
      if (pr?.state === 'merged') return pr.reverted ? { value: 0, why: `merged, then reverted by ${pr.reverted.url}` } : { value: 1, why: 'merged' };
      return pr?.state === 'closed' ? { value: 0, why: 'closed with no merge' } : undefined;
    case 'rework': {
      const n = f.reworks + f.reruns + Math.max(0, f.attempts - 1);
      return { value: 1 / (1 + n), why: n === 0 ? 'none' : `${f.reworks} rework, ${f.reruns} run again, ${Math.max(0, f.attempts - 1)} retry` };
    }
    case 'cost':
      return f.costUsd === undefined ? undefined : { value: halfAt(f.costUsd, s.costScaleUsd), why: `$${f.costUsd.toFixed(2)} estimated` };
    case 'time':
      return f.wallMs === undefined ? undefined : { value: halfAt(f.wallMs, s.timeScaleMinutes * 60_000), why: `${minutes(f.wallMs)} of work${f.queueMs !== undefined ? `, ${minutes(f.queueMs)} in the queue` : ''}` };
  }
}

/** The automatic grade: the weighted mean of the signals the facts give, 0 to 100, with each line. */
export function autoGradeOf(f: GradeFacts, s: GradeSettings): AutoGrade {
  const lines = GRADE_SIGNALS.flatMap((signal): GradeLine[] => {
    const weight = s.weights[signal];
    const v = weight > 0 ? signalOf(signal, f, s) : undefined;
    return v ? [{ signal, weight, ...v }] : [];
  });
  const weights = lines.reduce((n, l) => n + l.weight, 0);
  return { score: weights === 0 ? 0 : Math.round((100 * lines.reduce((n, l) => n + l.weight * l.value, 0)) / weights), lines };
}

const DAY = 86_400_000;

/** Each reverted pull request (its URL) and its revert, from the landing batches' `revert_opened` and `reverted` events. */
export function revertsOf(events: readonly DomainEvent[]): Map<string, GradeRevert> {
  const culprits = new Map<string, string>();
  const reverts = new Map<string, GradeRevert>();
  for (const e of events) {
    const d = e.data as { repo: string; sha: string; culpritPullRequest?: number; url: string };
    const key = `${d.repo}@${d.sha}`;
    if (e.type === 'landing_batch.revert_opened' && d.culpritPullRequest !== undefined) culprits.set(key, `https://github.com/${d.repo}/pull/${d.culpritPullRequest}`);
    if (e.type === 'landing_batch.reverted' && culprits.has(key) && !reverts.has(culprits.get(key)!)) reverts.set(culprits.get(key)!, { at: e.at, url: d.url });
  }
  return reverts;
}

const msBetween = (from: string | undefined, to: string | undefined): number | undefined =>
  (from && to ? Math.max(0, Date.parse(to) - Date.parse(from)) : undefined);

/**
 * An ended job's facts, from its record, its own events (`GRADE_EVENTS`), its token cost and the reverts: a revert counts
 * only within `windowDays` of its pull request's merge.
 */
export function gradeFactsOf(
  job: Job, events: readonly DomainEvent[], cost: { costUsd: number; costKnown: boolean } | undefined,
  reverts: ReadonlyMap<string, GradeRevert>, windowDays = DEFAULT_GRADE_SETTINGS.revertWindowDays,
): GradeFacts {
  let pr: GradeFacts['pullRequest'];
  let fixChecks = 0, reworks = 0, reruns = 0;
  for (const e of events) {
    const d = e.data as { pullRequest?: string; step?: string };
    if (e.type === 'job.pull_request_followed' && d.pullRequest && pr?.url !== d.pullRequest) pr = { url: d.pullRequest, state: 'open' };
    if (e.type === 'job.pull_request_merged' && d.pullRequest) pr = { url: d.pullRequest, state: 'merged', mergedAt: e.at };
    if (e.type === 'job.pull_request_closed' && d.pullRequest && pr?.state !== 'merged') pr = { url: d.pullRequest, state: 'closed' };
    if (e.type === 'job.pull_request_tended' && d.step === 'fix_checks') fixChecks += 1;
    if (e.type === 'job.rework_requested') reworks += 1;
    if (e.type === 'job.rerun') reruns += 1;
  }
  const revert = pr?.state === 'merged' ? reverts.get(pr.url) : undefined;
  if (pr && revert && Date.parse(revert.at) - Date.parse(pr.mergedAt!) <= windowDays * DAY) pr = { ...pr, reverted: revert };
  const queueMs = msBetween(job.createdAt, job.startedAt), wallMs = msBetween(job.startedAt, job.finishedAt);
  return {
    status: job.status === 'failed' ? 'failed' : 'finished', ...(job.partlyDone ? { partlyDone: true as const } : {}),
    ...(pr ? { pullRequest: pr } : {}), fixChecks, reworks, reruns, attempts: job.attempts,
    ...(cost?.costKnown ? { costUsd: cost.costUsd } : {}), ...(queueMs !== undefined ? { queueMs } : {}), ...(wallMs !== undefined ? { wallMs } : {}),
  };
}

/** Whether a job ended in a way a grade judges: done (finished) or failed. A cancelled or rejected job did no work to judge. */
export const gradedEnd = (status: Job['status']): boolean => status === 'finished' || status === 'failed';

/**
 * An ended job's keys: its executor, model (the costliest in its token ledger, else the one its payload names),
 * machine (its lane's, else the one its token ledger was read on last, else its machine pin).
 */
export function gradeKeysOf(job: Job, model: string | undefined, machine?: string): Pick<GradeRow, 'jobId' | 'endedAt' | 'executor' | 'model' | 'repo' | 'kind' | 'machine'> {
  const m = model ?? (typeof job.spec.payload.model === 'string' ? job.spec.payload.model : undefined);
  const at = machineOfLane(job.laneId) ?? machine ?? job.spec.machineId;
  return {
    jobId: job.id, endedAt: job.finishedAt ?? job.updatedAt, executor: job.spec.executor, ...(m ? { model: m } : {}),
    ...(job.source?.repo ? { repo: job.source.repo.toLowerCase() } : {}), kind: workKindOf(job.spec), ...(at ? { machine: at } : {}),
  };
}

/** One group of a rollup: its jobs, the mean automatic grade, the mean user grade (1 to 5) of those a person graded, and how many disagree. */
export interface GradeRollupRow { key: string; jobs: number; auto: number; userGraded: number; user?: number; disagreements: number }

const mean = (xs: number[]): number => Math.round((xs.reduce((n, x) => n + x, 0) / xs.length) * 10) / 10;

/** The rows summed per group, the best mean automatic grade first. A group the row cannot name is `(none)`. */
export function gradeRollup(rows: readonly GradeRow[], by: GradeGroup): GradeRollupRow[] {
  const groups = new Map<string, GradeRow[]>();
  for (const r of rows) {
    const key = r[by] ?? '(none)';
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups].map(([key, rs]): GradeRollupRow => {
    const users = rs.filter((r) => r.user);
    return {
      key, jobs: rs.length, auto: mean(rs.map((r) => r.auto.score)), userGraded: users.length,
      ...(users.length > 0 ? { user: mean(users.map((r) => r.user!.score)) } : {}),
      disagreements: users.filter((r) => disagreesOf(r.auto.score, r.user!.score)).length,
    };
  }).sort((a, b) => b.auto - a.auto || a.key.localeCompare(b.key));
}
