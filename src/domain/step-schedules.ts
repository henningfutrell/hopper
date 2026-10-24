// Step schedules (issue #2716, design.md "Step schedules"): a person schedules a box step — one command in a sandbox of an
// approved template — that the hopper runs at a fixed time each day, with no job and no agent. The step's files come from a
// repository at its default branch, read with the user's own GitHub connection when the run starts. Each run is kept: its
// start, end, exit code and output. A schedule is run once per due time at the most, never twice at once, and a due time a
// stopped hopper missed runs once when it starts again, never twice.

/** A schedule's name: what `hopper schedule` and the routes name it by. */
export const STEP_SCHEDULE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A daily time in UTC, `HH:MM`. */
const DAILY = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** The longest a scheduled run may run, in seconds: as a box step's. */
export const STEP_SCHEDULE_TIMEOUT_MAX_S = 6 * 3600;
/** The runs kept of each schedule: the newest; older ones are swept. */
export const SCHEDULED_RUNS_KEPT = 30;
/** The most of a run's output kept, in characters; then a note that it is cut. */
export const SCHEDULED_RUN_LOG_MAX = 1024 * 1024;

/** A person's vault grant to a schedule: its runs get the vault secrets its template gives. Who and when. */
export interface StepScheduleGrant { by: string; at: string }

export interface StepSchedule {
  name: string;
  /** The template its runs' sandboxes are made from. */
  template: string;
  /** The repository its files come from (`owner/name`), at its default branch. */
  repo: string;
  /** The folder of the repository the run gets, in its work directory at the same path. */
  input: string;
  /** The script it runs (`sh <script>`), a file in `input`. */
  script: string;
  /** When it is due: each day at this time, in UTC (`HH:MM`). */
  daily: string;
  timeoutSeconds: number;
  /** Who saved it, and when: no due time before then runs. */
  savedBy: string;
  savedAt: string;
  /** The vault grant a person gave it; a save that changes what it runs takes it back. */
  grant?: StepScheduleGrant;
}

/** How a run began: its due time came, or a person ran it now. */
export type ScheduledRunTrigger = 'due' | 'now';

/** A run's end: `succeeded` (exit 0, no problem), `failed`, or `interrupted` (a hopper stopped while it ran: not run again). */
export type ScheduledRunOutcome = 'succeeded' | 'failed' | 'interrupted';

export interface ScheduledRun {
  id: string;
  schedule: string;
  /** The due time it is the run of; for a run now, its start. */
  due: string;
  trigger: ScheduledRunTrigger;
  /** Who ran it now. */
  by?: string;
  /** The saga that runs it. */
  saga?: string;
  /** The sandbox it runs in (`hopper-need-…`). */
  box: string;
  startedAt: string;
  endedAt?: string;
  outcome?: ScheduledRunOutcome;
  exit?: number;
  /** Why it failed when the hopper could not start it, stopped it, or it timed out. */
  problem?: string;
}

/** A schedule as the routes answer it: its next due time, and its newest run. */
export interface StepScheduleView extends StepSchedule { nextDue: string; lastRun?: ScheduledRun }

/** The schedules of a user (`GET /api/step-schedules`); `failed`: the schedules whose newest run did not succeed, for Needs you. */
export interface StepSchedulesView { schedules: StepScheduleView[]; failed: string[] }

/** One schedule's runs, newest first, each with its output (`GET /api/step-schedules/:name`). */
export interface StepScheduleRunsView { schedule: StepScheduleView; runs: (ScheduledRun & { log: string })[] }

/** What a person saves: the schedule's fields, but who and when. */
export type StepScheduleFields = Pick<StepSchedule, 'name' | 'template' | 'repo' | 'input' | 'script' | 'daily' | 'timeoutSeconds'>;

const at = (d: Date, hh: number, mm: number): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm));

/** The newest due time of `daily` at or before `now`. */
export function latestDue(daily: string, now: Date): Date {
  const [hh, mm] = daily.split(':').map(Number) as [number, number];
  const today = at(now, hh, mm);
  return today.getTime() <= now.getTime() ? today : new Date(today.getTime() - 86_400_000);
}

/** The first due time of `daily` after `now`. */
export const nextDue = (daily: string, now: Date): Date => new Date(latestDue(daily, now).getTime() + 86_400_000);

/**
 * The due time of `s` to run now, if one is due: the newest at or before `now` that is after the schedule was saved. A due
 * time a stopped hopper missed is that one, once; older missed ones are not run.
 */
export function dueNow(s: Pick<StepSchedule, 'daily' | 'savedAt'>, now: Date): string | undefined {
  const due = latestDue(s.daily, now);
  return due.getTime() > Date.parse(s.savedAt) ? due.toISOString() : undefined;
}

/** A repository path: relative, no `..`, no empty part. */
const pathOk = (p: string): boolean => p.length > 0 && !p.startsWith('/') && p.split('/').every((x) => x !== '' && x !== '.' && x !== '..');

/** Why the fields cannot be saved; undefined: they can. */
export function stepScheduleProblem(f: StepScheduleFields): string | undefined {
  if (!STEP_SCHEDULE_NAME.test(f.name)) return 'name: lower-case letters, digits and -, at most 63, starting with a letter or a digit';
  if (f.template.trim() === '') return 'template: give the template its runs use';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(f.repo)) return 'repo: owner/name';
  const input = f.input.replace(/\/+$/, '');
  if (!pathOk(input)) return 'input: a folder of the repository, relative to its root, with no ..';
  if (!pathOk(f.script) || !f.script.startsWith(`${input}/`)) return `script: a file in the input folder ${input}`;
  if (!DAILY.test(f.daily)) return 'daily: a time in UTC, HH:MM (00:00 to 23:59)';
  if (!Number.isInteger(f.timeoutSeconds) || f.timeoutSeconds < 1 || f.timeoutSeconds > STEP_SCHEDULE_TIMEOUT_MAX_S) return `timeout: whole seconds, 1 to ${STEP_SCHEDULE_TIMEOUT_MAX_S}`;
  return undefined;
}

/** Whether a save changes what the schedule runs: then its vault grant goes, and a person grants it again. */
export const changesWhatRuns = (a: StepScheduleFields, b: StepScheduleFields): boolean =>
  a.template !== b.template || a.repo.toLowerCase() !== b.repo.toLowerCase() || a.input !== b.input || a.script !== b.script;

/** The key of a schedule's vault grant, as Access decides it (`vault_grant#can_grant`). */
export const scheduleGrantKey = (name: string): string => `schedule:${name}`;

/** The schedules whose newest run did not succeed: Needs you lists them until a run succeeds. */
export const failedSchedules = (views: readonly StepScheduleView[]): string[] =>
  views.filter((v) => v.lastRun?.outcome !== undefined && v.lastRun.outcome !== 'succeeded').map((v) => v.name);

export interface StepScheduleRepository {
  list(): StepSchedule[];
  get(name: string): StepSchedule | undefined;
  /** Keeps `s`, replacing the schedule of its name. */
  put(s: StepSchedule): void;
  /** Removes the schedule and its runs; whether it was there. */
  remove(name: string): boolean;
  /**
   * Keeps a new run, unless the schedule has a run of the same due time, or one that has not ended: whether it was kept.
   * The database decides, so two hoppers on one database never keep two.
   */
  claim(run: ScheduledRun): boolean;
  run(id: string): ScheduledRun | undefined;
  /** The runs of a schedule, newest first; `limit` at most. */
  runs(schedule: string, limit?: number): ScheduledRun[];
  /** The newest run of each schedule. */
  newest(): Map<string, ScheduledRun>;
  /** The runs not ended. */
  open(): ScheduledRun[];
  sagaIs(id: string, saga: string): void;
  appendLog(id: string, text: string): void;
  log(id: string): string;
  /** Ends the run, once: whether this end was kept. */
  end(id: string, end: Required<Pick<ScheduledRun, 'endedAt' | 'outcome' | 'exit'>> & Pick<ScheduledRun, 'problem'>): boolean;
  /** Removes the runs of each schedule but its newest `keep`. */
  sweep(keep: number): void;
}
