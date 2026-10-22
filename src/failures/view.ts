// What the Failures view reads (issue #509): how many failures are left, from the work-item ledger (issues #517, #1067), the hand-offs waiting on a
// person and those closed in the last day (issue #516), the open problems and those resolved in the last day, the
// newest assessed failures still open (issues #529, #618) and those that ended in the last day, the profile — and, on
// each problem, failure and hand-off (issue #551), whether the daemon takes each action now and why not. The routes
// refuse with the same reasons, so the view offers only what is taken.
import { everyJobRepository } from '../domain/job-repositories.ts';
import type { UserStore } from '../domain/ports.ts';
import { DEFAULT_YOLO_MODE, highFirst, jobPriorityTag, pullRequestList, stuckOf, type Allowed, type Discarding, type FailureCounts, type FailureRecord, type FailureSettings, type FailuresView, type Handoff, type HandoffResolutionAction, type HandoffView, type Job, type Problem, type ProblemView } from '../domain/types.ts';
import { HANDOFF_WAIT } from '../domain/work-items.ts';
import { blockedStuck } from '../domain/item-lifecycle.ts';
import { handoffCard, takenCard } from './card.ts';
import { keptWorkViews, type Sessions } from './kept-work.ts';
import { knownCauses, matchCause, NO_WAY_TO_HOPPER } from './causes.ts';
import { RAN_AGAIN, SETTLED } from './handoff.ts';
import { live, liveWhy } from './continued.ts';
import { profileOf } from './profile.ts';
import { tldrSettings } from '../tldr/service.ts';
import { withShownTldr } from '../tldr/text.ts';

const DAY_MS = 86_400_000;
const PROFILE_DAYS = 14;
const RECENT = 50;
/** How many of the newest records are read for the open failures and those that ended. */
const SCAN = 500;
const OK: Allowed = { ok: true };
const no = (why: string): Allowed => ({ ok: false, why });

type Reads = Pick<UserStore, 'failures' | 'problems' | 'jobs' | 'workItems'>;

/** Records by their job's live priority, highest first, each priority in the order given (issue #535). */
export function highestFirst(store: Pick<UserStore, 'jobs'>, records: FailureRecord[]): FailureRecord[] {
  // Their jobs in one read (issue #1411): a sort asks for each record's priority many times.
  const jobs = store.jobs.getMany(records.map((r) => r.jobId));
  const priorityOf = (r: FailureRecord): number => jobs.get(r.jobId)?.priority ?? 0;
  return records.map((r, i) => ({ r, i })).sort((a, b) => priorityOf(b.r) - priorityOf(a.r) || a.i - b.i).map((x) => x.r);
}

/**
 * The newer job of its item, when the job is not its item's newest. `newest`: the newest of each item as read for a pass
 * over many jobs (`jobs.newestOfItems`, issue #1411); else a read of its own.
 */
export function newerOf(store: Pick<UserStore, 'jobs'>, job: Job, newest?: ReadonlyMap<string, Job>): string | undefined {
  const key = job.source?.key;
  const n = key === undefined ? undefined : newest ? newest.get(key) : store.jobs.getBySourceKey(key);
  return n && n.id !== job.id ? n.id : undefined;
}

/**
 * How many failures are left (issues #517, #1067): the work items the ledger has as failed, and those handed to a person
 * on their failure — the counts every other view reads too.
 */
export function countsOf(store: Pick<UserStore, 'workItems'>): FailureCounts {
  return {
    failed: store.workItems.counts().failed,
    needsPerson: store.workItems.list({ state: ['needs_you'] }).filter((i) => i.waitingOn === HANDOFF_WAIT).length,
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
 * outcome), its hand-off closed, its job ended finished, or, with no hand-off, its job was dismissed (issue #1123). Nothing
 * waits on an ended one.
 */
export function endedAt(store: Pick<UserStore, 'jobs' | 'handoffs'>, r: FailureRecord): string | undefined {
  if (r.pending) return undefined;
  if (r.outcome && (RAN_AGAIN.includes(r.outcome) || SETTLED.includes(r.outcome))) return r.outcomeAt ?? r.at;
  const h = r.handoffId ? store.handoffs.get(r.handoffId) : undefined;
  if (h?.status === 'closed') return h.closedAt ?? r.at;
  const job = store.jobs.get(r.jobId);
  if (job?.status === 'finished') return job.finishedAt ?? r.at;
  if (job?.dismissedAt !== undefined && h === undefined) return job.dismissedAt;
  return undefined;
}

/** Whether the job's source takes its item back now (issue #1010): the sync loop's `takesBack`. */
export type TakesBack = (jobId: string) => Allowed;

/** Whether the job can run again, and its source takes its item back (issue #1010). */
function runsAgain(store: Pick<UserStore, 'jobs'>, jobId: string, takesBack: TakesBack): Allowed {
  const newest = newestOfItem(store, jobId);
  return newest.ok ? takesBack(jobId) : newest;
}

/** Whether a person may run a failure's job again now. */
export function recordRetry(store: Reads, r: FailureRecord, takesBack: TakesBack): Allowed {
  if (r.pending) return no(r.pending === 'retry' ? 'it runs again by itself' : 'it is being run again');
  if (r.outcome === 'retried' || r.outcome === 'redirected' || r.outcome === 'released' || r.outcome === 'superseded') return no('already run again');
  if (r.outcome === 'item_closed') return no('its item is closed');
  if (r.outcome === 'held') return no('it waits on its problem: resolve or release it');
  return runsAgain(store, r.jobId, takesBack);
}

/** A resolution in words, as the card and the refusals say it (issue #551). */
export const RESOLUTION_TEXT: Record<HandoffResolutionAction, string> = {
  continue: 'continued', fixed: 'fixed and run again', done_by_hand: 'done by hand', wont_do: 'won\'t do',
};

/** A resolution's key in a hand-off's `actions`. */
const RESOLUTION_KEY = { continue: 'continue', fixed: 'fixed', done_by_hand: 'doneByHand', wont_do: 'wontDo' } as const;

/** Whether a person may resolve the hand-off `id` (`h`, as `view` shows it) so now (issue #1194: checked before the answer): its job, or why not. */
export function resolvableOf(id: string, h: Handoff | undefined, action: HandoffResolutionAction, view: (h: Handoff) => HandoffView):
  { ok: true; value: { jobId: string } } | { ok: false; reason: 'not_found' | 'conflict'; message: string } {
  if (!h) return { ok: false, reason: 'not_found', message: `hand-off ${id} not found` };
  const allowed = view(h).actions[RESOLUTION_KEY[action]];
  return allowed.ok ? { ok: true, value: { jobId: h.jobId } } : { ok: false, reason: 'conflict', message: `hand-off ${id} cannot be ${RESOLUTION_TEXT[action]}: ${allowed.why}` };
}

/**
 * Whether a person may resolve a hand-off each way now, and why not (issue #551): one that runs its item again
 * (Continue, I fixed it) only while it is the newest job of its item and nothing runs it again already; Done by hand
 * and Won't do while it is open, and those only while its source takes its item back (`takesBack`, issue #1010).
 * `resumable`: whether its job's own agent session can resume — then Continue resumes it, else it runs a new job, as for a
 * failure with no way to the hopper (issue #2233). Its
 * card (issue #621) says what happened and the resolution to take, one the hopper takes now (`takenCard`).
 */
export function handoffView(store: Pick<UserStore, 'failures' | 'jobs'>, h: Handoff, resumable: (job: Job) => boolean, takesBack: TakesBack): HandoffView {
  const record = h.recordId ? store.failures.get(h.recordId) : undefined;
  const job = store.jobs.get(h.jobId);
  const learn = record ? { signature: record.signature, ...(record.causeName ? { causeName: record.causeName } : {}) } : {};
  // A session with no way to the hopper (issue #2233) keeps telling its agent the hopper is out of reach: Continue runs a new job.
  const continueResumes = job !== undefined && resumable(job) && (record?.causeId ?? matchCause(h.error, '', [])?.id) !== NO_WAY_TO_HOPPER;
  const card = handoffCard(h, continueResumes);
  if (h.status === 'closed') {
    const closed = no(h.resolution ? `already resolved: ${RESOLUTION_TEXT[h.resolution.action]}` : 'already closed');
    return { ...h, ...learn, continueResumes, card, actions: { continue: closed, fixed: closed, doneByHand: closed, wontDo: closed } };
  }
  // Its job live again (issue #1777): no resolution, Done and Won't do included — they would end a job about to do the
  // work. The hand-off closes by itself, `resumed`.
  if (job && live(job)) {
    const none = no(`${liveWhy(job.status)}, and this hand-off closes by itself`);
    const actions = { continue: none, fixed: none, doneByHand: none, wontDo: none };
    return { ...h, ...learn, continueResumes, card: { ...card, why: `Nothing to do: its job ${liveWhy(job.status).replace(/^it /, '')}.` }, actions };
  }
  const pending = record?.pending;
  const runs: Allowed = pending ? { ok: false, why: pending === 'retry' ? 'it runs again by itself' : 'it is being run again', soon: true } : runsAgain(store, h.jobId, takesBack);
  const actions = { continue: runs, fixed: runs, doneByHand: OK, wontDo: OK };
  return { ...h, ...learn, continueResumes, card: takenCard(card, actions), actions };
}

function problemView(store: Reads, p: Problem): ProblemView {
  const held = releasable(store, p.id);
  return {
    ...p, held: held.map((r) => r.jobId),
    actions: { resolve: p.status === 'open' ? OK : no('already resolved'), release: held.length > 0 ? OK : no('no job is held') },
  };
}

/** The Pull requests page's cards (issue #637), as it reads them: those the hopper gave up on are stuck work. */
function pullRequestCards(store: Pick<UserStore, 'jobs' | 'settings' | 'connectedAccounts'>, now: Date) {
  const view = pullRequestList(store.jobs.list({ status: ['finished', 'failed'], followed: true }), (key) => store.jobs.getBySourceKey(key), store.settings.getYoloMode() ?? DEFAULT_YOLO_MODE, everyJobRepository(store), now.getTime(), (id) => store.jobs.get(id));
  return view.repos.flatMap((g) => g.pullRequests);
}

/**
 * The jobs of the items blocked with no pull request to wait on (issues #1231, #1891: the item reconciler blocks them), or
 * with their pull request closed without a merge on GitHub while the item reconciler does not run them again: stuck work.
 */
function prOpenStale(store: Reads, now: Date): string[] {
  return store.workItems.list({ state: ['blocked'] }).filter((i) => blockedStuck(i, now.toISOString())).map((i) => i.jobId ?? i.key);
}

export function viewOf(store: Reads & Pick<UserStore, 'settings' | 'handoffs' | 'events' | 'connectedAccounts'>, settings: FailureSettings, now: Date, sessions: Sessions, takesBack: TakesBack, discarding?: (jobId: string) => Discarding | undefined): FailuresView {
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const handoffs = [...store.handoffs.list({ status: 'open' }), ...store.handoffs.list({ status: 'closed', closedSince: dayAgo, limit: 50 })];
  const resolved = store.problems.list({ status: 'resolved', limit: 50 }).filter((p) => (p.resolvedAt ?? '') >= dayAgo);
  const since = new Date(now.getTime() - PROFILE_DAYS * DAY_MS).toISOString();
  // Each with its job's live priority (issue #535); the open hand-offs of high-priority jobs first.
  const saved = store.settings.getPriorityLanes();
  const tag = (jobId: string) => jobPriorityTag(store.jobs, saved, jobId);
  const tldr = tldrSettings(store);
  const recordView = (r: FailureRecord) => ({ ...r, ...tag(r.jobId), actions: { retry: recordRetry(store, r, takesBack) } });
  const shownHandoffs = highFirst(handoffs.map((h) => ({ ...handoffView(store, withShownTldr('handoff', h, tldr), sessions.resumable, takesBack), ...tag(h.jobId) })), (h) => h.status === 'open' && h.high === true);
  const keptWork = keptWorkViews(store, sessions, takesBack, discarding);
  const recent = store.failures.list({ limit: SCAN, notOutcome: [...SETTLED, ...RAN_AGAIN] }).filter((r) => endedAt(store, r) === undefined).slice(0, RECENT).map(recordView);
  return {
    now: now.toISOString(),
    counts: countsOf(store),
    settings,
    // Each with its TL;DR (issue #569) only while it is shown.
    handoffs: shownHandoffs,
    causes: knownCauses(store.settings.getNamedCauses()),
    // Work not pushed (issue #1010): ended jobs whose reap kept work, each with Push it and Discard.
    keptWork,
    // Stuck work (issue #1010): each item that waits on a person, by its cause, with one bulk action or what to do.
    stuck: stuckOf({ handoffs: shownHandoffs, recent, keptWork, pullRequests: pullRequestCards(store, now), jobs: store.jobs.list({ status: ['waiting_on', 'queued', 'claimed', 'running'] }), prOpen: prOpenStale(store, now) }),
    problems: [...store.problems.list({ status: 'open' }), ...resolved].map((p) => problemView(store, p)),
    // Nothing waits on an ended one (issues #529, #618): out of the open failures, in Ended for a day, still in the profile.
    recent,
    ended: store.failures.list({ limit: SCAN }).filter((r) => (endedAt(store, r) ?? '') >= dayAgo).slice(0, RECENT).map(recordView),
    profile: profileOf(store.failures.list({ since, limit: 5000 }), now.toISOString(), { days: PROFILE_DAYS, generalThreshold: settings.groupThreshold }),
  };
}
