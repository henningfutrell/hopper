// What the Failures view reads (issue #509): how many failed jobs are left (issue #517), the hand-offs waiting on a
// person and those closed in the last day (issue #516), the open problems and those resolved in the last day, the
// newest assessed failures still open (issues #529, #618) and those that ended in the last day, the profile — and, on
// each problem, failure and hand-off (issue #551), whether the daemon takes each action now and why not. The routes
// refuse with the same reasons, so the view offers only what is taken.
import type { UserStore } from '../domain/ports.ts';
import { highFirst, jobPriorityTag, type Allowed, type FailureCounts, type FailureRecord, type FailureSettings, type FailuresView, type Handoff, type HandoffResolutionAction, type HandoffView, type Job, type Problem, type ProblemView } from '../domain/types.ts';
import { knownCauses } from './causes.ts';
import { RAN_AGAIN, SETTLED } from './handoff.ts';
import { profileOf } from './profile.ts';

const DAY_MS = 86_400_000;
const PROFILE_DAYS = 14;
const RECENT = 50;
/** How many of the newest records are read for the open failures and those that ended. */
const SCAN = 500;
const OK: Allowed = { ok: true };
const no = (why: string): Allowed => ({ ok: false, why });

type Reads = Pick<UserStore, 'failures' | 'problems' | 'jobs'>;

/** Records by their job's live priority, highest first, each priority in the order given (issue #535). */
export function highestFirst(store: Pick<UserStore, 'jobs'>, records: FailureRecord[]): FailureRecord[] {
  const priorityOf = (r: FailureRecord): number => store.jobs.get(r.jobId)?.priority ?? 0;
  return records.map((r, i) => ({ r, i })).sort((a, b) => priorityOf(b.r) - priorityOf(a.r) || a.i - b.i).map((x) => x.r);
}

/** The newer job of its item, when the job is not its item's newest. */
export function newerOf(store: Pick<UserStore, 'jobs'>, job: Job): string | undefined {
  const newest = job.source ? store.jobs.getBySourceKey(job.source.key) : undefined;
  return newest && newest.id !== job.id ? newest.id : undefined;
}

/** How many failed jobs are left (issue #517): not assessed yet, and handed off to a person (open hand-offs). */
export function countsOf(store: Pick<UserStore, 'jobs' | 'handoffs'>): FailureCounts {
  return {
    unassessed: store.jobs.list({ status: ['failed'], unassessed: true }).length,
    needsPerson: store.handoffs.list({ status: 'open', limit: 1_000_000 }).length,
  };
}

/** Whether the job can run again: it exists, has a source, and is the newest job of its item. */
export function newestOfItem(store: Pick<UserStore, 'jobs'>, jobId: string): Allowed {
  const job = store.jobs.get(jobId);
  if (!job) return no('its job is gone');
  if (!job.source) return no('its job has no source to run it again');
  if (store.jobs.getBySourceKey(job.source.key)?.id !== jobId) return no('a newer job of its item exists');
  return OK;
}

/** The records of a problem whose jobs wait on its release, and can run again. */
export function releasable(store: Reads, problemId: string): FailureRecord[] {
  return store.failures.list({ problemId }).filter((r) => r.outcome === 'held' && r.pending === undefined && newestOfItem(store, r.jobId).ok);
}

/**
 * When a failure ended (issue #618), or undefined while it is open: its job ran again or something settled it (its
 * outcome), its hand-off closed, or its job ended finished. Nothing waits on an ended one.
 */
export function endedAt(store: Pick<UserStore, 'jobs' | 'handoffs'>, r: FailureRecord): string | undefined {
  if (r.pending) return undefined;
  if (r.outcome && (RAN_AGAIN.includes(r.outcome) || SETTLED.includes(r.outcome))) return r.outcomeAt ?? r.at;
  const h = r.handoffId ? store.handoffs.get(r.handoffId) : undefined;
  if (h?.status === 'closed') return h.closedAt ?? r.at;
  const job = store.jobs.get(r.jobId);
  if (job?.status === 'finished') return job.finishedAt ?? r.at;
  return undefined;
}

/** Whether a person may run a failure's job again now. */
export function recordRetry(store: Reads, r: FailureRecord): Allowed {
  if (r.pending) return no(r.pending === 'retry' ? 'it runs again by itself' : 'it is being run again');
  if (r.outcome === 'retried' || r.outcome === 'redirected' || r.outcome === 'released' || r.outcome === 'superseded') return no('already run again');
  if (r.outcome === 'item_closed') return no('its item is closed');
  if (r.outcome === 'held') return no('it waits on its problem: resolve or release it');
  return newestOfItem(store, r.jobId);
}

/** A resolution in words, as the card and the refusals say it (issue #551). */
export const RESOLUTION_TEXT: Record<HandoffResolutionAction, string> = {
  continue: 'continued', fixed: 'fixed and run again', done_by_hand: 'done by hand', wont_do: 'won\'t do',
};

/**
 * Whether a person may resolve a hand-off each way now, and why not (issue #551): one that runs its item again
 * (Continue, I fixed it) only while it is the newest job of its item and nothing runs it again already; Done by hand
 * and Won't do while it is open. `resumable`: whether its job's own agent session can resume — then Continue resumes
 * it, else it runs a new job.
 */
export function handoffView(store: Pick<UserStore, 'failures' | 'jobs'>, h: Handoff, resumable: (job: Job) => boolean): HandoffView {
  const record = h.recordId ? store.failures.get(h.recordId) : undefined;
  const job = store.jobs.get(h.jobId);
  const learn = record ? { signature: record.signature, ...(record.causeName ? { causeName: record.causeName } : {}) } : {};
  const continueResumes = job !== undefined && resumable(job);
  if (h.status === 'closed') {
    const closed = no(h.resolution ? `already resolved: ${RESOLUTION_TEXT[h.resolution.action]}` : 'already closed');
    return { ...h, ...learn, continueResumes, actions: { continue: closed, fixed: closed, doneByHand: closed, wontDo: closed } };
  }
  const pending = record?.pending;
  const runs = pending ? no(pending === 'retry' ? 'it runs again by itself' : 'it is being run again') : newestOfItem(store, h.jobId);
  return { ...h, ...learn, continueResumes, actions: { continue: runs, fixed: runs, doneByHand: OK, wontDo: OK } };
}

function problemView(store: Reads, p: Problem): ProblemView {
  const held = releasable(store, p.id);
  return {
    ...p, held: held.map((r) => r.jobId),
    actions: { resolve: p.status === 'open' ? OK : no('already resolved'), release: held.length > 0 ? OK : no('no job is held') },
  };
}

export function viewOf(store: Reads & Pick<UserStore, 'settings' | 'handoffs'>, settings: FailureSettings, now: Date, resumable: (job: Job) => boolean): FailuresView {
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const handoffs = [...store.handoffs.list({ status: 'open' }), ...store.handoffs.list({ status: 'closed', closedSince: dayAgo, limit: 50 })];
  const resolved = store.problems.list({ status: 'resolved', limit: 50 }).filter((p) => (p.resolvedAt ?? '') >= dayAgo);
  const since = new Date(now.getTime() - PROFILE_DAYS * DAY_MS).toISOString();
  // Each with its job's live priority (issue #535); the open hand-offs of high-priority jobs first.
  const saved = store.settings.getPriorityLanes();
  const tag = (jobId: string) => jobPriorityTag(store.jobs, saved, jobId);
  const recordView = (r: FailureRecord) => ({ ...r, ...tag(r.jobId), actions: { retry: recordRetry(store, r) } });
  return {
    now: now.toISOString(),
    counts: countsOf(store),
    settings,
    handoffs: highFirst(handoffs.map((h) => ({ ...handoffView(store, h, resumable), ...tag(h.jobId) })), (h) => h.status === 'open' && h.high === true),
    causes: knownCauses(store.settings.getNamedCauses()),
    problems: [...store.problems.list({ status: 'open' }), ...resolved].map((p) => problemView(store, p)),
    // Nothing waits on an ended one (issues #529, #618): out of the open failures, in Ended for a day, still in the profile.
    recent: store.failures.list({ limit: SCAN, notOutcome: [...SETTLED, ...RAN_AGAIN] }).filter((r) => endedAt(store, r) === undefined).slice(0, RECENT).map(recordView),
    ended: store.failures.list({ limit: SCAN }).filter((r) => (endedAt(store, r) ?? '') >= dayAgo).slice(0, RECENT).map(recordView),
    profile: profileOf(store.failures.list({ since, limit: 5000 }), now.toISOString(), { days: PROFILE_DAYS, generalThreshold: settings.groupThreshold }),
  };
}
