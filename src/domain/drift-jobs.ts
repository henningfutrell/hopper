// Drift in the hopper's own records (issue #1077, design.md "Component watchers"): the work-item ledger against the job
// records (`ledgerJobsDrift`), and the lanes against the jobs they run (`lanesJobsDrift`). The job record is the source of
// truth for both: the ledger is folded from the job's events, and a lane is opened and freed by the job's Decisions. A job
// or an item that changed in the grace is no drift yet. Pure: no I/O, no clock.
import type { Drift, DriftItem } from './drift.ts';
import { TERMINAL_STATUSES, type Job, type JobStatus, type Lane } from './types.ts';
import { isActive, type WorkItem, type WorkItemState } from './work-items.ts';

export const LEDGER_JOBS = 'ledger-jobs';
export const LANES_JOBS = 'lanes-jobs';

/**
 * The ledger states a job's status gives its item while the job is not over. A question, a proposal or a research report keeps the
 * item `working` until it reaches a person (issue #1174); a job's own background command keeps it `working`. Absent (`operator_led`): worked by hand, no check.
 */
const LEDGER_FOR: Partial<Record<JobStatus, readonly WorkItemState[]>> = {
  queued: ['queued'], held: ['queued'], claimed: ['working'], running: ['working'],
  waiting_answer: ['working', 'needs_you'], parked: ['needs_you'], waiting_on: ['waiting_outside', 'working'],
};

/** The statuses in which a job holds a lane. */
const HOLDS_LANE: readonly JobStatus[] = ['claimed', 'running'];

const ended = (j: Job): boolean => TERMINAL_STATUSES.includes(j.status);
const settled = (at: string | undefined, before: number): boolean => at === undefined || Date.parse(at) <= before;
const since = (at: string | undefined): { since?: string } => (at ? { since: at } : {});

const group = (watcher: string, found: [string, DriftItem][]): Drift[] => {
  const byKind = new Map<string, DriftItem[]>();
  for (const [kind, i] of found) byKind.set(kind, [...byKind.get(kind) ?? [], i]);
  return [...byKind].map(([kind, items]) => ({ watcher, kind, items }));
};

/**
 * The drift between each work item and the job it names (`job` undefined: no such job), one per kind, in the order given:
 * `active_but_job_ended` (stale: the ledger says a job or a person acts on it, the job is over — a hand-off on that failed
 * job excepted), `ended_but_job_active` (the ledger missed a start), `state_differs` (an active state the job's status
 * does not give). An item or a job that changed in `graceMs` is no drift yet.
 */
export function ledgerJobsDrift(pairs: readonly { item: WorkItem; job: Job | undefined }[], now: string, graceMs: number): Drift[] {
  const before = Date.parse(now) - graceMs;
  const found: [string, DriftItem][] = [];
  for (const { item, job } of pairs) {
    if (!settled(item.eventAt, before) || (job && !settled(job.updatedAt, before))) continue;
    const at = { key: item.key, says: item.state };
    if (!job) {
      if (isActive(item.state)) found.push(['active_but_job_ended', { ...at, truth: 'no such job' }]);
      continue;
    }
    const truth = `job ${job.status}`;
    if (ended(job)) {
      const handOff = item.state === 'needs_you' && item.failedJobId === job.id;
      if (isActive(item.state) && !handOff) found.push(['active_but_job_ended', { ...at, truth, ...since(job.finishedAt) }]);
      continue;
    }
    const expected = LEDGER_FOR[job.status];
    if (!expected) continue;
    if (!isActive(item.state)) found.push(['ended_but_job_active', { ...at, truth, ...since(item.stateSince) }]);
    else if (!expected.includes(item.state)) found.push(['state_differs', { ...at, truth, ...since(item.stateSince) }]);
  }
  return group(LEDGER_JOBS, found);
}

/**
 * The drift between the lanes and `jobs` (the jobs that hold a lane, and those a lane names): `lane_busy_job_not_running`
 * (a lane busy or draining with a job that is not claimed or running, or names no job: stuck), `job_running_no_lane` (a
 * claimed or running job no busy or draining lane runs: idle while it runs). A job that changed in `graceMs` is no drift yet.
 */
export function lanesJobsDrift(lanes: readonly Lane[], jobs: readonly Job[], now: string, graceMs: number): Drift[] {
  const before = Date.parse(now) - graceMs;
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const found: [string, DriftItem][] = [];
  const running = new Set<string>();
  for (const l of lanes) {
    if (l.state === 'idle' || !l.jobId) continue;
    running.add(l.jobId);
    const job = byId.get(l.jobId);
    if (job && (HOLDS_LANE.includes(job.status) || !settled(job.updatedAt, before))) continue;
    if (!job && !settled(l.openedAt, before)) continue;
    found.push(['lane_busy_job_not_running', { key: l.id, says: `${l.state} with a job`, truth: job ? `job ${job.status}` : 'no such job', ...since(job?.finishedAt) }]);
  }
  for (const j of jobs) {
    if (!HOLDS_LANE.includes(j.status) || running.has(j.id) || !settled(j.updatedAt, before)) continue;
    found.push(['job_running_no_lane', { key: j.id, says: 'no lane runs it', truth: `job ${j.status}`, ...since(j.startedAt) }]);
  }
  return group(LANES_JOBS, found);
}
