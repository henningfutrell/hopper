// The work-item ledger (issue #1067, design.md "The work-item ledger"): where each work item stands, one answer for every
// view. A work item is one item of a source (its source key: an issue's URL), whichever of its jobs works it. Its state is
// folded from the events, in order, by `applyEvent`, and from what a read of GitHub said of its issue and its pull request,
// by `applyRead`; `stateOf` settles the two. Pure: no I/O, no clock. The store runs it in the transaction that appends the
// event (src/store/work-items.ts), and a rebuild replays every event through it.
import type { GraphNode } from './issue-graph.ts';
import type { DomainEvent, EventType } from './types.ts';
import { applyLanding, isLandingUndone, LANDING_LEDGER_EVENTS, landingOf, type ItemLanding } from './work-item-landing.ts';
import type { ChangeKind } from './change-kinds.ts';
import { waitOnLabel, type WaitOn } from './wait-on.ts';
import { BLOCKED_CAUSES, BLOCKED_WORDS, closedOnGitHub, hasReference, type BlockedCause } from './item-lifecycle.ts';

/**
 * Where a work item stands, in the words every view uses. `waiting_for_approval`: a request card in Intake. `queued`: a job
 * waits for a free lane. `working`: a job is at work, its own background command included. `needs_you`: a question, a
 * proposal or research report at a person (issue #1174), a hand-off or a parked job waits on a person.
 * `waiting_outside`: a job waits on something outside (`waitingOn` names it).
 * `pr_open`: its pull request is open, on its way to the merge. `partly_done`: one part merged, the rest runs next.
 * `done`: its pull request merged, or its issue closed as completed. `failed`: its last job failed, nothing took its place
 * and no person dismissed it — the only failure any view counts. `blocked` (issue #1891): it broke its state's promise
 * and waits on a person (`blockedCause`: `no_pr`, its job ended done with no pull request to wait on; `stale`, past its
 * deadline with no move; `pr_closed`, its pull request closed without a merge on GitHub). `dropped`: dismissed, declined,
 * cancelled, rejected, its pull request closed without a merge by a person's Close PR, its issue closed as not planned, or
 * blocked and a person's Won't do (`work_item.dropped`).
 */
export const WORK_ITEM_STATES = [
  'waiting_for_approval', 'queued', 'working', 'needs_you', 'waiting_outside', 'pr_open', 'partly_done', 'done', 'failed', 'blocked', 'dropped',
] as const;
export type WorkItemState = typeof WORK_ITEM_STATES[number];

/** What an item handed to a person on its failure waits on: Needs a person's count. */
export const HANDOFF_WAIT = 'a hand-off';
/** What an item whose job the hopper parked to move it off its machine waits on (issue #1892): the move's pick up. */
export const MOVE_WAIT = 'a move to another machine';

/** The states in which a job or a person still acts on the item: what GitHub says of it waits until they end. */
const ACTIVE: ReadonlySet<WorkItemState> = new Set(['waiting_for_approval', 'queued', 'working', 'needs_you', 'waiting_outside']);
export const isActive = (state: WorkItemState): boolean => ACTIVE.has(state);

export type PullRequestState = 'open' | 'merged' | 'closed' | 'abandoned';

/**
 * What an open pull request waits on first (issue #1067, part 3): to be marked ready, a fix of its merge conflicts, a fix
 * of its failed checks, its checks to pass, or the merge. Never "ready for review": a job's pull request is on its way to
 * the merge.
 */
export const PULL_REQUEST_WAITS = ['draft', 'conflicts', 'fixing_checks', 'checks_running', 'merge'] as const;
export type PullRequestWait = typeof PULL_REQUEST_WAITS[number];

/** An item's `waitingOn` while its pull request waits on that. */
export const PULL_REQUEST_WAIT_WORDS: Readonly<Record<PullRequestWait, string>> = {
  draft: 'its draft to be marked ready', conflicts: 'a fix of its merge conflicts', fixing_checks: 'a fix of its failed checks',
  checks_running: 'its checks to pass', merge: 'the merge',
};

/** What a pull request waits on, from what was seen of it: a draft first, then merge conflicts, then its checks. */
export function pullRequestWaitOf(seen: { draft?: boolean; conflicting?: boolean; checks?: string }): PullRequestWait {
  if (seen.draft) return 'draft';
  if (seen.conflicting) return 'conflicts';
  if (seen.checks === 'failing') return 'fixing_checks';
  if (seen.checks === 'pending') return 'checks_running';
  return 'merge';
}

export interface WorkItem {
  /** Its source key: the issue's URL. */
  key: string;
  /** Where it stands: `eventState` settled with what GitHub said of its issue and pull request (`stateOf`). */
  state: WorkItemState;
  /** When it entered `state`. */
  stateSince: string;
  /** Where the events alone put it. */
  eventState: WorkItemState;
  /** When the newest event that moved it happened: a read of GitHub older than it says nothing new. */
  eventAt: string;
  /** The job that works it now: its newest. */
  jobId?: string;
  pullRequest?: string;
  pullRequestState?: PullRequestState;
  /** A pull request merged as the whole item since its job took it (`job.pull_request_merged`, not a `part`; issue #1356), kept while a job still acts on it. */
  wholeMerged?: true;
  /** What its open pull request waits on, as the follow last saw it (`job.pull_request_seen`). */
  pullRequestWait?: PullRequestWait;
  /** Its pull request's change kind (issue #1076), as `job.pull_request_classified` last said. */
  changeKind?: ChangeKind;
  /** `open` or `closed`, and why it closed (`completed`, `not_planned`, `duplicate`), as GitHub said. */
  issueState?: string; issueReason?: string;
  /** What it waits on, in plain words. */
  waitingOn?: string;
  /** The job whose failure it is, while `failed`. */
  failedJobId?: string;
  /** Why it is blocked, while `blocked` (issue #1891). */
  blockedCause?: BlockedCause;
  /** A person was asked about it, once, while it stays blocked for the same cause (`work_item.person_asked`, issue #1891). */
  personAsked?: true;
  /**
   * A person took its state's end label off the issue by hand (issue #1892, `work_item.label_edited`): the label, and the
   * Run again it asks for. Kept until the item moves: Intake gives it no reason, so the next discover runs it again.
   */
  runAgainAsked?: string;
  /** A person's Won't do dropped it (issue #1892): a blocked item's in Intake, or a hand-off's; kept while it stays dropped. */
  wontDo?: true;
  /** A person resolved its hand-off as Done by hand (issue #1892): its job's work is done, by them; kept while it stays done. */
  doneByHand?: true;
  /** How many of its pull requests in a row were closed without a merge on GitHub (issue #1891); a merge ends the row. */
  closedWithoutMerge?: number;
  /** The jobs of it whose work was kept, not pushed (`job.work_kept`), until removed. */
  keptWork: string[];
  /** Its merged pull request on its way from the landing branch to the tested branch (issue #1073): `work-item-landing.ts`. */
  landing?: ItemLanding;
  /** While it waits for approval: the source whose request card it is (part 4), so only that source withdraws it. */
  requestSource?: string;
  /** One more at each change. */
  version: number;
}

/** What the ledger needs of the job an event names: its item, its kind, and the pull request it follows. */
export interface LedgerJob { id: string; key: string; kind?: string; pullRequest?: string }

/** What a read of GitHub said of an item's issue (the issue graph's node), or of a pull request. */
export type LedgerRead = { kind: 'issue'; at: string; state: string; reason?: string } | { kind: 'pull_request'; url: string; state: string };

/** The events the ledger reads; every other event leaves every item as it is. */
export const LEDGER_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'source.request_opened', 'source.request_approved', 'source.request_auto_approved', 'source.request_declined', 'source.request_withdrawn',
  'job.queued', 'job.claimed', 'job.started', 'job.continued', 'job.wait_ended', 'job.reattached', 'job.requeued',
  'job.parked', 'job.unparked', 'job.waiting', 'job.wait_polled', 'question.escalated_to_human', 'proposal.escalated_to_human', 'research.escalated_to_human',
  'handoff.opened', 'handoff.closed', 'job.finished', 'job.failed', 'job.cancelled', 'job.rejected', 'job.dismissed',
  'job.pull_request_followed', 'job.pull_request_merged', 'job.pull_request_closed', 'job.pull_request_abandoned', 'job.pull_request_classified',
  'job.work_kept', 'job.work_removed', 'job.pull_request_seen', 'work_item.issue_closed', 'work_item.issue_reopened', 'work_item.reconciled', 'work_item.dropped', 'work_item.person_asked',
  'work_item.label_edited', ...LANDING_LEDGER_EVENTS,
]);

/** The source key an event without a job names (a request card's, or an issue GitHub closed or reopened), else undefined. */
export function keyOfEvent(event: Pick<DomainEvent, 'type' | 'data'>): string | undefined {
  return (event.type.startsWith('source.request_') || event.type.startsWith('work_item.')) && typeof event.data.key === 'string' ? event.data.key : undefined;
}

/** The job an event is about: its own, or a question's. */
export function jobIdOfEvent(event: Pick<DomainEvent, 'jobId' | 'data'>): string | undefined {
  return event.jobId ?? (typeof event.data.jobId === 'string' ? event.data.jobId : undefined);
}

/** What a job's end says when it shipped nothing that waits for a merge. */
const DONE_RESULTS: readonly string[] = ['operator-led work complete', 'issue closed as complete', 'done by hand'];
/** Why an issue closed when it is not done by its close. */
const NOT_COMPLETED: readonly string[] = ['not_planned', 'duplicate'];

/**
 * Where the item stands: what the events say, unless they say no job or person acts on it and GitHub says it ended. A
 * culprit of a red batch, and its change reverted from the landing branch, is failed (issue #1175): its merge shipped
 * nothing that stays, whatever its issue says, until a new job takes the item over.
 */
export function stateOf(i: Pick<WorkItem, 'eventState' | 'pullRequest' | 'pullRequestState' | 'issueState' | 'issueReason' | 'landing'>): WorkItemState {
  if (isActive(i.eventState)) return i.eventState;
  if (isLandingUndone(landingOf(i))) return 'failed';
  if (i.eventState === 'done') return i.eventState;
  if (i.pullRequestState === 'merged' && i.eventState !== 'partly_done') return 'done';
  if (i.issueState?.toLowerCase() === 'closed') return NOT_COMPLETED.includes((i.issueReason ?? '').toLowerCase()) ? 'dropped' : 'done';
  return i.eventState;
}

const settled = (prev: WorkItem | undefined, next: Omit<WorkItem, 'state' | 'stateSince' | 'version'>, at: string): WorkItem => {
  const state = stateOf(next);
  return { ...next, state, stateSince: prev && prev.state === state ? prev.stateSince : at, version: (prev?.version ?? 0) + 1 };
};

const resultText = (data: Record<string, unknown>): string => {
  const r = data.result;
  if (typeof r === 'string') return r;
  return r && typeof r === 'object' && typeof (r as { summary?: unknown }).summary === 'string' ? (r as { summary: string }).summary : '';
};

type Base = Omit<WorkItem, 'state' | 'stateSince' | 'version'>;

/** The item after `event`; `job` is the job the event names, `key` the item's. Undefined: the event does not touch it. */
export function applyEvent(item: WorkItem | undefined, event: Pick<DomainEvent, 'type' | 'at' | 'data'>, key: string, job?: LedgerJob): WorkItem | undefined {
  if (!LEDGER_EVENT_TYPES.has(event.type)) return undefined;
  const d = event.data;
  const base: Base = item
    ? (({ state: _s, stateSince: _ss, version: _v, ...rest }) => rest)(item)
    : { key, eventState: 'queued', eventAt: event.at, keptWork: [] };
  // A state that needs a pull request is never written without one (issue #1891): with none, the item is blocked on it.
  const move = (eventState: WorkItemState, change: Partial<Base> = {}): WorkItem => {
    const next: Base = { ...base, ...change, eventState, eventAt: event.at };
    for (const k of Object.keys(change) as (keyof Base)[]) if (change[k] === undefined) delete next[k];
    if (!hasReference(eventState, next)) Object.assign(next, { eventState: 'blocked', blockedCause: 'no_pr', waitingOn: BLOCKED_WORDS.no_pr });
    delete next.runAgainAsked; if (change.wontDo !== true || next.eventState !== 'dropped') delete next.wontDo; if (change.doneByHand !== true || next.eventState !== 'done') delete next.doneByHand; if (next.eventState !== 'blocked') delete next.blockedCause; if (next.eventState !== 'blocked' || base.eventState !== 'blocked' || next.blockedCause !== base.blockedCause) delete next.personAsked;
    return settled(item, next, event.at);
  };
  const mark = (change: Partial<Base>): WorkItem => {
    const next: Base = { ...base, ...change }; for (const k of Object.keys(change) as (keyof Base)[]) if (change[k] === undefined) delete next[k];
    return settled(item, next, event.at); };

  // A request card, before any job.
  if (event.type === 'source.request_opened') {
    if (item && isActive(item.eventState)) return undefined;
    return move('waiting_for_approval', { waitingOn: 'an owner\'s approval of the request', ...(typeof d.source === 'string' ? { requestSource: d.source } : {}) });
  }
  // Declined, or withdrawn: its source no longer offers it, with no person's approval or decline (part 4).
  if (event.type === 'source.request_declined' || event.type === 'source.request_withdrawn') {
    return item?.eventState === 'waiting_for_approval' ? move('dropped', { waitingOn: undefined, requestSource: undefined }) : undefined;
  }
  if (event.type === 'source.request_approved' || event.type === 'source.request_auto_approved') return item?.eventState === 'waiting_for_approval' ? move('queued', { waitingOn: undefined, requestSource: undefined }) : undefined;
  // GitHub closed or reopened the item's issue (a delivery, or the fallback read): as a read of the issue says it.
  if (event.type === 'work_item.issue_closed' || event.type === 'work_item.issue_reopened') {
    if (!item) return undefined;
    const reason = typeof d.reason === 'string' ? d.reason : undefined;
    return applyRead(item, { kind: 'issue', at: event.at, state: event.type === 'work_item.issue_closed' ? 'closed' : 'open', ...(reason ? { reason } : {}) });
  }
  // The item reconciler's correction (issue #1891): folded again from its job's end, or blocked. Only from the state it saw.
  if (event.type === 'work_item.reconciled') {
    if (!item || item.state !== d.from) return undefined; const replay = d.replay as { type: EventType; data: Record<string, unknown> } | undefined;
    if (replay) return job && job.id === item.jobId ? applyEvent(item, { type: replay.type, at: event.at, data: replay.data }, key, job) : undefined;
    const cause = BLOCKED_CAUSES.find((c) => c === d.cause);
    // Partly done: its merged part is history, so it is not read as the whole item's merge (`stateOf`).
    return cause ? move('blocked', { blockedCause: cause, waitingOn: BLOCKED_WORDS[cause], ...(base.eventState === 'partly_done' ? { pullRequest: undefined, pullRequestState: undefined } : {}) }) : undefined;
  }
  // A person's Won't do on a blocked item (issue #1891): dropped. Only a blocked item.
  if (event.type === 'work_item.dropped') return item?.eventState === 'blocked' ? move('dropped', { waitingOn: undefined, wontDo: true }) : undefined;
  // The one notice of a blocked item (issue #1891): its state stays; once. A move out of blocked, or to another cause, forgets it.
  if (event.type === 'work_item.person_asked') return item?.state === 'blocked' && item.personAsked !== true ? mark({ personAsked: true }) : undefined;
  // A label a person took off by hand (issue #1892): a Run again, asked while the item stays in the state it was seen in.
  if (event.type === 'work_item.label_edited') return item !== undefined && item.state === d.from && typeof d.label === 'string' && item.runAgainAsked === undefined ? mark({ runAgainAsked: d.label }) : undefined;
  if (!job) return undefined;

  // A new job of the item takes it over: what an earlier job and GitHub said of it is history.
  if (event.type === 'job.queued') {
    return move('queued', { jobId: job.id, pullRequest: undefined, pullRequestState: undefined, wholeMerged: undefined, pullRequestWait: undefined, changeKind: undefined, issueState: undefined, issueReason: undefined, waitingOn: undefined, failedJobId: undefined, landing: undefined, requestSource: undefined, blockedCause: undefined });
  }
  // Any job's kept work and pull request: a tend hands a pull request to a newer job, and an older job's merge still counts.
  if (event.type === 'job.work_kept') return item?.keptWork.includes(job.id) ? undefined : mark({ keptWork: [...base.keptWork, job.id] });
  if (event.type === 'job.work_removed') return item?.keptWork.includes(job.id) ? mark({ keptWork: base.keptWork.filter((j) => j !== job.id) }) : undefined;
  const current = base.jobId === undefined || base.jobId === job.id;
  const pr = typeof d.pullRequest === 'string' ? d.pullRequest : undefined;
  // What the follow saw its open pull request wait on: the item's own pull request only.
  if (event.type === 'job.pull_request_seen') {
    const wait = d.wait as PullRequestWait;
    // A job's end records its pull request only once its report kept it: the first look names it, and an item blocked
    // for want of one (issue #1891) is in PR open again.
    const noPullRequest = base.eventState === 'blocked' && base.blockedCause === 'no_pr';
    const named = base.pullRequest === undefined && (base.eventState === 'pr_open' || noPullRequest) && base.jobId === job.id;
    if (pr === undefined || !(named || (pr === base.pullRequest && base.pullRequestState === 'open')) || (!named && base.pullRequestWait === wait)) return undefined;
    const change = {
      pullRequestWait: wait, ...(named ? { pullRequest: pr, pullRequestState: 'open' as const } : {}),
      ...(base.eventState === 'pr_open' || noPullRequest ? { waitingOn: PULL_REQUEST_WAIT_WORDS[wait] } : {}),
    };
    return noPullRequest ? move('pr_open', change) : mark(change);
  }
  // A pull request's change kind (issue #1076): its state stays; any job's, as a tend hands a pull request on.
  if (event.type === 'job.pull_request_classified') {
    const kind = d.kind as ChangeKind;
    return (current || pr === base.pullRequest) && base.changeKind !== kind ? mark({ changeKind: kind }) : undefined;
  }
  if (event.type === 'job.pull_request_merged') {
    // A stray's merge on GitHub (issue #1420): as a stray's close, it moves no item; only its own pull request's state.
    if (d.stray === true) return pr !== undefined && pr === base.pullRequest ? mark({ pullRequestState: 'merged' as const, pullRequestWait: undefined }) : undefined;
    const change = { pullRequest: pr, pullRequestState: 'merged' as const, ...(d.part === true ? {} : { wholeMerged: true as const }), pullRequestWait: undefined, waitingOn: undefined, closedWithoutMerge: undefined };
    if (isActive(base.eventState)) return mark(change);
    return d.part === true ? move('partly_done', { ...change, waitingOn: 'the next part' }) : move('done', change);
  }
  if (event.type === 'job.pull_request_closed' || event.type === 'job.pull_request_abandoned') {
    // A stray's close (issue #1143 part 4): no job followed it, so it ends no wait of the item; only its own pull request's state.
    if (d.stray === true) return pr !== undefined && pr === base.pullRequest ? mark({ pullRequestState: 'closed' as const, pullRequestWait: undefined }) : undefined;
    const change = { pullRequest: pr, pullRequestState: event.type === 'job.pull_request_closed' ? 'closed' as const : 'abandoned' as const, pullRequestWait: undefined, waitingOn: undefined };
    if (isActive(base.eventState) || base.eventState === 'done') return mark(change);
    // Closed without a merge on GitHub (issue #1891): the item waits on a run again, the item reconciler's the first time in a row.
    return closedOnGitHub(event) ? move('blocked', { ...change, blockedCause: 'pr_closed', waitingOn: BLOCKED_WORDS.pr_closed, closedWithoutMerge: (base.closedWithoutMerge ?? 0) + 1 }) : move('dropped', change);
  }
  // Everything else is the current job's: an older job's end moves nothing.
  if (!current) return undefined;
  /** What an open pull request waits on: what the follow saw of it, until it says. */
  const prWait = (url: string | undefined): string => (url !== undefined && url === base.pullRequest && base.pullRequestWait ? PULL_REQUEST_WAIT_WORDS[base.pullRequestWait] : 'its pull request: checks and the merge');
  switch (event.type) {
    case 'job.claimed': case 'job.started': case 'job.continued': case 'job.wait_ended': case 'job.reattached':
      return move('working', { waitingOn: undefined, failedJobId: undefined });
    case 'job.requeued':
      return move('queued', { waitingOn: undefined });
    case 'job.unparked':
      return d.to === 'waiting_answer' ? move('needs_you', { waitingOn: 'a question' }) : move('queued', { waitingOn: undefined });
    // Parked to move it off its machine (issue #1892): no person holds it; the move picks it up elsewhere.
    case 'job.parked': return typeof d.move === 'string' ? move('queued', { waitingOn: MOVE_WAIT }) : move('needs_you', { waitingOn: 'a person to pick up the parked job' });
    case 'job.waiting': {
      const what = typeof d.for === 'string' ? d.for : 'something outside';
      return d.ownCommand === true ? move('working', { waitingOn: what }) : move('waiting_outside', { waitingOn: what });
    }
    // Its own command only polls hopper state (issue #1210): what it waits on, not "its own command".
    case 'job.wait_polled':
      return move('working', { waitingOn: `${waitOnLabel(d.on as WaitOn)} (it polls the hopper)` });
    case 'question.escalated_to_human':
      return move('needs_you', { waitingOn: 'a question' });
    // A review item at a person (issue #1174): its job waits on the decision; the job's requeue or end moves it on.
    case 'proposal.escalated_to_human':
      return move('needs_you', { waitingOn: 'a proposal' });
    case 'research.escalated_to_human':
      return move('needs_you', { waitingOn: 'a research report' });
    case 'handoff.opened':
      return move('needs_you', { waitingOn: HANDOFF_WAIT, failedJobId: job.id });
    case 'handoff.closed':
      if (d.end === 'wont_do') return move('dropped', { waitingOn: undefined, wontDo: true });
      if (d.end === 'done_by_hand') return base.eventState === 'needs_you' ? move('done', { waitingOn: undefined, failedJobId: undefined, doneByHand: true }) : undefined;
      // Its job live again (issue #1777): it works on, as after `job.continued`.
      if (d.end === 'resumed') return base.eventState === 'needs_you' ? move('working', { waitingOn: undefined, failedJobId: undefined }) : undefined;
      return base.eventState === 'needs_you' && ['cleared', 'superseded', 'item_closed', 'job_gone'].includes(String(d.end)) ? move('failed', { waitingOn: undefined }) : undefined;
    case 'job.finished': {
      if (typeof d.partlyDone === 'string') return move('pr_open', { pullRequest: d.partlyDone, pullRequestState: 'open', waitingOn: 'the merge of its part', failedJobId: undefined });
      const shipped = DONE_RESULTS.some((r) => resultText(d).startsWith(r)) || job.kind === 'direct';
      if (shipped) return move('done', { waitingOn: undefined, failedJobId: undefined, ...(base.eventState === 'done' && base.doneByHand ? { doneByHand: true as const } : {}) });
      return move('pr_open', { ...(job.pullRequest ? { pullRequest: job.pullRequest, pullRequestState: 'open' as const } : {}), waitingOn: prWait(job.pullRequest), failedJobId: undefined });
    }
    case 'job.pull_request_followed':
      return isActive(base.eventState) ? mark({ pullRequest: pr, pullRequestState: 'open' }) : move('pr_open', { pullRequest: pr, pullRequestState: 'open', waitingOn: prWait(pr), failedJobId: undefined });
    case 'job.failed':
      return move('failed', { failedJobId: job.id, waitingOn: undefined });
    case 'job.cancelled': case 'job.rejected':
      return move('dropped', { waitingOn: undefined, failedJobId: undefined });
    case 'job.dismissed':
      return base.eventState === 'failed' || base.eventState === 'needs_you' ? move('dropped', { waitingOn: undefined, failedJobId: undefined }) : undefined;
    default:
      return undefined;
  }
}

/** The item after a `landing_batch.*` event (`applyLanding`), its state settled with its stage; undefined: it does not move it. */
export function applyLandingEvent(item: WorkItem, event: Pick<DomainEvent, 'type' | 'at' | 'data'>): WorkItem | undefined {
  const next = applyLanding(item, event);
  if (!next) return undefined;
  const { state: _s, stateSince: _ss, version: _v, ...base } = next;
  return settled(item, base, event.at);
}

/**
 * The item after a read of GitHub; undefined: it says nothing new. A read of the issue older than the item's newest event is
 * old news. A reopen after a close (issue #1232) ends its landing stage: the merge it waited on is history, and the reopen is
 * a person's, so the hopper does not take the item for one its batch promoted and close its issue again. A block that a close as
 * completed hid (issue #1892) is history at the reopen: the item is done, and Intake judges the reopen as a done item's.
 */
export function applyRead(item: WorkItem, read: LedgerRead): WorkItem | undefined {
  const { state: _s, stateSince: _ss, version: _v, ...base } = item;
  if (read.kind === 'pull_request') {
    if (item.pullRequest !== read.url || read.state.toLowerCase() !== 'merged' || item.pullRequestState === 'merged') return undefined;
    return settled(item, { ...base, pullRequestState: 'merged' }, item.eventAt);
  }
  if (read.at < item.eventAt) return undefined;
  const issueState = read.state.toLowerCase();
  const issueReason = read.reason?.toLowerCase();
  if (item.issueState === issueState && item.issueReason === issueReason) return undefined;
  const next: Base = { ...base, issueState }; if (issueReason) next.issueReason = issueReason; else delete next.issueReason;
  if (issueState === 'open' && item.issueState === 'closed' && base.eventState === 'blocked' && !NOT_COMPLETED.includes(item.issueReason ?? '')) {
    Object.assign(next, { eventState: 'done' }); for (const k of ['blockedCause', 'waitingOn', 'personAsked', 'runAgainAsked'] as const) delete next[k];
  }
  if (item.issueState === 'closed' && issueState === 'open') delete next.landing; return settled(item, next, read.at);
}

/**
 * Whether `jobId`'s failure is its item's (issue #1067): the item is `failed` on it, or a person holds it on its hand-off.
 * Dismissed, run again, replaced or its issue closed, it is no failure: the one rule every view and the queue's locked
 * entries read.
 */
export function isFailureOf(item: Pick<WorkItem, 'state' | 'failedJobId'> | undefined, jobId: string): boolean {
  return item !== undefined && item.failedJobId === jobId && (item.state === 'failed' || item.state === 'needs_you');
}

/**
 * The jobs of the item whose kept work still waits on a person (issue #1067): none once the item is done or its issue
 * closed; else only its newest job's own. A newer job of the item took the place of an older one, so the older job's kept
 * work is history even when the newer job failed too (issue #1457).
 */
export function keptWorkShown(item: Pick<WorkItem, 'state' | 'jobId' | 'issueState' | 'keptWork'>): string[] {
  if (item.state === 'done' || item.issueState === 'closed') return [];
  return item.keptWork.filter((j) => j === item.jobId);
}

/**
 * Whether the item's issue closed as complete, as the ledger holds it (part 4): closed, not as not planned or a duplicate.
 * The sync's rule for a failed job whose work landed (issue #350): one answer with `stateOf`'s.
 */
export function issueClosedAsComplete(item: Pick<WorkItem, 'issueState' | 'issueReason'> | undefined): boolean {
  return item?.issueState === 'closed' && !NOT_COMPLETED.includes(item.issueReason ?? '');
}

/** The keys of the request cards of `source` the ledger has waiting for approval (part 4): what Intake withdraws when it no longer offers them. */
export function requestsWaitingOf(items: Iterable<Pick<WorkItem, 'key' | 'eventState' | 'requestSource'>>, source: string): string[] {
  return [...items].filter((i) => i.eventState === 'waiting_for_approval' && i.requestSource === source).map((i) => i.key);
}

/** A GitHub issue's URL: what the fallback read can read. */
const GITHUB_ISSUE = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/issues\/\d+$/;

/**
 * The states whose items the fallback read reads: no job or person acts on them, and they are not done (issue #1105); and
 * a job's wait on something outside (issue #1356), as its issue's close by a batch run, which no event of the hopper's
 * records: the read's close wakes the job.
 */
export const FALLBACK_READ_STATES: readonly WorkItemState[] = WORK_ITEM_STATES.filter((s) => (!isActive(s) && s !== 'done') || s === 'waiting_outside');

/**
 * The issues the ledger's fallback read reads now (issue #1067, part 3): of the items in `FALLBACK_READ_STATES` (`pr_open`,
 * `partly_done`, `failed`, `dropped`: its issue may have closed as completed since, issue #1105; `waiting_outside`, issue
 * #1356) whose key is a GitHub
 * issue, those with no news for `quietMs` — no event moved them and the read did not read them — , the one read longest
 * ago (never first, then the oldest news), at most `limit`.
 */
export function fallbackReadPick(items: readonly WorkItem[], lastRead: ReadonlyMap<string, string>, now: string, o: { quietMs: number; limit: number }): string[] {
  const before = new Date(Date.parse(now) - o.quietMs).toISOString();
  const quiet = items.filter((i) => FALLBACK_READ_STATES.includes(i.state) && GITHUB_ISSUE.test(i.key)
    && i.eventAt <= before && (lastRead.get(i.key) ?? '') <= before);
  const since = (i: WorkItem) => lastRead.get(i.key) ?? '';
  return quiet.sort((a, b) => since(a).localeCompare(since(b)) || a.eventAt.localeCompare(b.eventAt)).slice(0, o.limit).map((i) => i.key);
}

/**
 * The event that records GitHub's close or reopen of an item's issue, as a GitHub delivery (`delivery`) or the fallback
 * read (`read`) found it; undefined when the ledger holds that already, or it is no close or reopen.
 */
export function issueChangeEvent(item: Pick<WorkItem, 'key' | 'issueState' | 'issueReason'>, issue: { state: string; reason?: string }, via: 'delivery' | 'read'):
  { type: 'work_item.issue_closed' | 'work_item.issue_reopened'; data: Record<string, unknown> } | undefined {
  if (issue.state === 'closed') {
    if (item.issueState === 'closed' && item.issueReason === issue.reason) return undefined;
    return { type: 'work_item.issue_closed', data: { key: item.key, ...(issue.reason ? { reason: issue.reason } : {}), via } };
  }
  return issue.state === 'open' && item.issueState === 'closed' ? { type: 'work_item.issue_reopened', data: { key: item.key, via } } : undefined;
}

/** How many items are in each state: every view's count. */
export function countStates(items: Iterable<Pick<WorkItem, 'state'>>): Record<WorkItemState, number> {
  const out = Object.fromEntries(WORK_ITEM_STATES.map((s) => [s, 0])) as Record<WorkItemState, number>;
  for (const i of items) out[i.state]++;
  return out;
}

/** The waits of an open pull request that keep its item in flight (issue #1113): its checks run, a job fixes them, or the merge. */
export const IN_FLIGHT_WAITS: readonly PullRequestWait[] = ['checks_running', 'fixing_checks', 'merge'];
/** The states an item in flight can be in: what the ledger reads to count them. */
export const IN_FLIGHT_STATES: readonly WorkItemState[] = ['working', 'pr_open'];

/**
 * The parts of in flight (issue #1164): `running`, a job at work on it; `ownCommand`, its job waits on its own background
 * command (it holds its lane: running work); `pullRequests`, its pull request is open with its checks running, its checks
 * being fixed, or waiting on the merge.
 */
export const IN_FLIGHT_PARTS = ['running', 'ownCommand', 'pullRequests'] as const;
export type InFlightPart = typeof IN_FLIGHT_PARTS[number];

/** How many items are in flight, and in each part: the one count the header's badge and the dashboard read (`GET /api/queue`). */
export type InFlight = { total: number } & Record<InFlightPart, number>;

/**
 * Which part of in flight the item is in (issue #1113, #1164), else undefined. A job's own command wait is the only own
 * wait in `working`; any other is `waiting_outside` and holds no lane. A draft or merge conflicts wait on a fix, not on
 * the run; a pull request whose wait the follow never read is not counted, so an item the follow lost never stays in flight.
 * The one rule the header's badge, the dashboard and the Jobs view's filter read.
 */
export function inFlightPartOf(i: Pick<WorkItem, 'state' | 'pullRequestWait' | 'waitingOn'>): InFlightPart | undefined {
  if (i.state === 'working') return i.waitingOn === undefined ? 'running' : 'ownCommand';
  return i.state === 'pr_open' && i.pullRequestWait !== undefined && IN_FLIGHT_WAITS.includes(i.pullRequestWait) ? 'pullRequests' : undefined;
}

/** Whether the item is in flight (`inFlightPartOf`). */
export const isInFlight = (i: Pick<WorkItem, 'state' | 'pullRequestWait' | 'waitingOn'>): boolean => inFlightPartOf(i) !== undefined;

/** How many items are in flight, and in each part. */
export function inFlightOf(items: Iterable<Pick<WorkItem, 'state' | 'pullRequestWait' | 'waitingOn'>>): InFlight {
  const out: InFlight = { total: 0, running: 0, ownCommand: 0, pullRequests: 0 };
  for (const i of items) {
    const part = inFlightPartOf(i);
    if (part === undefined) continue;
    out[part]++;
    out.total++;
  }
  return out;
}

/** The ledger: each item's row, and the counts every view reads. */
export interface WorkItemLedger {
  /** Fold one appended event into its item. Called by the event log in the append's transaction. */
  applyEvent(event: DomainEvent): void;
  /** Fold what a read of the issue graph said of issues and pull requests into their items. Called in the read's transaction. */
  applyNodes(nodes: readonly GraphNode[], readAt: string): void;
  get(key: string): WorkItem | undefined;
  /** The item whose pull request is `url`, whatever its case (issue #1074: a job's repo query of it; issue #1072: its `pr status`); the newest state change first. */
  byPullRequest(url: string): WorkItem | undefined;
  /** The items, the newest state change first; `keptWork`: only those that hold kept work; `landing`: only those with a landing stage. */
  list(filter?: { state?: WorkItemState[]; keptWork?: true; landing?: true; limit?: number }): WorkItem[];
  /** How many items are in each state: `SELECT state, count(*)`. */
  counts(): Record<WorkItemState, number>;
  /** How many items are in flight, and in each part (`inFlightOf`, issues #1113, #1164). */
  inFlight(): InFlight;
  /**
   * The items not ended whose next check is at or before `now` (issue #1891): the item reconciler's pass, the
   * longest due first, at most `limit`.
   */
  due(now: string, limit: number): WorkItem[];
  /** The item reconciler checked the item at `version` and found it keeps its promise: it is checked next at `nextCheckAt`. */
  checked(key: string, version: number, nextCheckAt: string): void;
  /** Replay every event and the issue graph through the reducer, in place of the rows there are. How many items. */
  rebuild(): number;
}
