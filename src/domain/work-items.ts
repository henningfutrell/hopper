// The work-item ledger (issue #1067, design.md "The work-item ledger"): where each work item stands, one answer for every
// view. A work item is one item of a source (its source key: an issue's URL), whichever of its jobs works it. Its state is
// folded from the events, in order, by `applyEvent`, and from what a read of GitHub said of its issue and its pull request,
// by `applyRead`; `stateOf` settles the two. Pure: no I/O, no clock. The store runs it in the transaction that appends the
// event (src/store/work-items.ts), and a rebuild replays every event through it.
import type { GraphNode } from './issue-graph.ts';
import type { DomainEvent, EventType } from './types.ts';

/**
 * Where a work item stands, in the words every view uses. `waiting_for_approval`: a request card in Intake. `queued`: a job
 * waits for a free lane. `working`: a job is at work, its own background command included. `needs_you`: a question, a
 * hand-off or a parked job waits on a person. `waiting_outside`: a job waits on something outside (`waitingOn` names it).
 * `pr_open`: its pull request is open, on its way to the merge. `partly_done`: one part merged, the rest runs next.
 * `done`: its pull request merged, or its issue closed as completed. `failed`: its last job failed, nothing took its place
 * and no person dismissed it — the only failure any view counts. `dropped`: dismissed, declined, cancelled, rejected, its
 * pull request closed without a merge, or its issue closed as not planned.
 */
export const WORK_ITEM_STATES = [
  'waiting_for_approval', 'queued', 'working', 'needs_you', 'waiting_outside', 'pr_open', 'partly_done', 'done', 'failed', 'dropped',
] as const;
export type WorkItemState = typeof WORK_ITEM_STATES[number];

/** The states in which a job or a person still acts on the item: what GitHub says of it waits until they end. */
const ACTIVE: ReadonlySet<WorkItemState> = new Set(['waiting_for_approval', 'queued', 'working', 'needs_you', 'waiting_outside']);
export const isActive = (state: WorkItemState): boolean => ACTIVE.has(state);

export type PullRequestState = 'open' | 'merged' | 'closed' | 'abandoned';

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
  /** `open` or `closed`, and why it closed (`completed`, `not_planned`, `duplicate`), as GitHub said. */
  issueState?: string;
  issueReason?: string;
  /** What it waits on, in plain words. */
  waitingOn?: string;
  /** The job whose failure it is, while `failed`. */
  failedJobId?: string;
  /** The jobs of it whose work was kept, not pushed (`job.work_kept`), until removed. */
  keptWork: string[];
  /** One more at each change. */
  version: number;
}

/** What the ledger needs of the job an event names: its item, its kind, and the pull request it follows. */
export interface LedgerJob { id: string; key: string; kind?: string; pullRequest?: string }

/** What a read of GitHub said of an item's issue (the issue graph's node), or of a pull request. */
export type LedgerRead =
  | { kind: 'issue'; at: string; state: string; reason?: string }
  | { kind: 'pull_request'; url: string; state: string };

/** The events the ledger reads; every other event leaves every item as it is. */
export const LEDGER_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'source.request_opened', 'source.request_approved', 'source.request_declined',
  'job.queued', 'job.claimed', 'job.started', 'job.continued', 'job.wait_ended', 'job.reattached', 'job.requeued',
  'job.parked', 'job.unparked', 'job.waiting', 'question.escalated_to_human', 'handoff.opened', 'handoff.closed',
  'job.finished', 'job.failed', 'job.cancelled', 'job.rejected', 'job.dismissed',
  'job.pull_request_followed', 'job.pull_request_merged', 'job.pull_request_closed', 'job.pull_request_abandoned',
  'job.work_kept', 'job.work_removed',
]);

/** The source key an event without a job names (a request card's), else undefined. */
export function keyOfEvent(event: Pick<DomainEvent, 'type' | 'data'>): string | undefined {
  return event.type.startsWith('source.request_') && typeof event.data.key === 'string' ? event.data.key : undefined;
}

/** The job an event is about: its own, or a question's. */
export function jobIdOfEvent(event: Pick<DomainEvent, 'jobId' | 'data'>): string | undefined {
  return event.jobId ?? (typeof event.data.jobId === 'string' ? event.data.jobId : undefined);
}

/** What a job's end says when it shipped nothing that waits for a merge. */
const DONE_RESULTS: readonly string[] = ['operator-led work complete', 'issue closed as complete', 'done by hand'];
/** Why an issue closed when it is not done by its close. */
const NOT_COMPLETED: readonly string[] = ['not_planned', 'duplicate'];

/** Where the item stands: what the events say, unless they say no job or person acts on it and GitHub says it ended. */
export function stateOf(i: Pick<WorkItem, 'eventState' | 'pullRequestState' | 'issueState' | 'issueReason'>): WorkItemState {
  if (isActive(i.eventState) || i.eventState === 'done') return i.eventState;
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
  const move = (eventState: WorkItemState, change: Partial<Base> = {}): WorkItem => {
    const next: Base = { ...base, ...change, eventState, eventAt: event.at };
    for (const k of Object.keys(change) as (keyof Base)[]) if (change[k] === undefined) delete next[k];
    return settled(item, next, event.at);
  };
  const mark = (change: Partial<Base>): WorkItem => {
    const next: Base = { ...base, ...change };
    for (const k of Object.keys(change) as (keyof Base)[]) if (change[k] === undefined) delete next[k];
    return settled(item, next, event.at);
  };

  // A request card, before any job.
  if (event.type === 'source.request_opened') return item && isActive(item.eventState) ? undefined : move('waiting_for_approval', { waitingOn: 'an owner\'s approval of the request' });
  if (event.type === 'source.request_declined') return item?.eventState === 'waiting_for_approval' ? move('dropped', { waitingOn: undefined }) : undefined;
  if (event.type === 'source.request_approved') return item?.eventState === 'waiting_for_approval' ? move('queued', { waitingOn: undefined }) : undefined;
  if (!job) return undefined;

  // A new job of the item takes it over: what an earlier job and GitHub said of it is history.
  if (event.type === 'job.queued') {
    return move('queued', { jobId: job.id, pullRequest: undefined, pullRequestState: undefined, issueState: undefined, issueReason: undefined, waitingOn: undefined, failedJobId: undefined });
  }
  // Any job's kept work and pull request: a tend hands a pull request to a newer job, and an older job's merge still counts.
  if (event.type === 'job.work_kept') return item?.keptWork.includes(job.id) ? undefined : mark({ keptWork: [...base.keptWork, job.id] });
  if (event.type === 'job.work_removed') return item?.keptWork.includes(job.id) ? mark({ keptWork: base.keptWork.filter((j) => j !== job.id) }) : undefined;
  const current = base.jobId === undefined || base.jobId === job.id;
  const pr = typeof d.pullRequest === 'string' ? d.pullRequest : undefined;
  if (event.type === 'job.pull_request_merged') {
    const change = { pullRequest: pr, pullRequestState: 'merged' as const, waitingOn: undefined };
    if (isActive(base.eventState)) return mark(change);
    return d.part === true ? move('partly_done', { ...change, waitingOn: 'the next part' }) : move('done', change);
  }
  if (event.type === 'job.pull_request_closed' || event.type === 'job.pull_request_abandoned') {
    const change = { pullRequest: pr, pullRequestState: event.type === 'job.pull_request_closed' ? 'closed' as const : 'abandoned' as const, waitingOn: undefined };
    return isActive(base.eventState) || base.eventState === 'done' ? mark(change) : move('dropped', change);
  }
  // Everything else is the current job's: an older job's end moves nothing.
  if (!current) return undefined;
  switch (event.type) {
    case 'job.claimed': case 'job.started': case 'job.continued': case 'job.wait_ended': case 'job.reattached':
      return move('working', { waitingOn: undefined, failedJobId: undefined });
    case 'job.requeued':
      return move('queued', { waitingOn: undefined });
    case 'job.unparked':
      return d.to === 'waiting_answer' ? move('needs_you', { waitingOn: 'a question' }) : move('queued', { waitingOn: undefined });
    case 'job.parked':
      return move('needs_you', { waitingOn: 'a person to pick up the parked job' });
    case 'job.waiting': {
      const what = typeof d.for === 'string' ? d.for : 'something outside';
      return d.ownCommand === true ? move('working', { waitingOn: what }) : move('waiting_outside', { waitingOn: what });
    }
    case 'question.escalated_to_human':
      return move('needs_you', { waitingOn: 'a question' });
    case 'handoff.opened':
      return move('needs_you', { waitingOn: 'a hand-off', failedJobId: job.id });
    case 'handoff.closed':
      if (d.end === 'wont_do') return move('dropped', { waitingOn: undefined });
      return base.eventState === 'needs_you' && ['cleared', 'superseded', 'item_closed', 'job_gone'].includes(String(d.end)) ? move('failed', { waitingOn: undefined }) : undefined;
    case 'job.finished': {
      if (typeof d.partlyDone === 'string') return move('pr_open', { pullRequest: d.partlyDone, pullRequestState: 'open', waitingOn: 'the merge of its part', failedJobId: undefined });
      const shipped = DONE_RESULTS.some((r) => resultText(d).startsWith(r)) || job.kind === 'direct';
      if (shipped) return move('done', { waitingOn: undefined, failedJobId: undefined });
      return move('pr_open', { ...(job.pullRequest ? { pullRequest: job.pullRequest, pullRequestState: 'open' as const } : {}), waitingOn: 'its pull request: checks and the merge', failedJobId: undefined });
    }
    case 'job.pull_request_followed':
      return isActive(base.eventState) ? mark({ pullRequest: pr, pullRequestState: 'open' }) : move('pr_open', { pullRequest: pr, pullRequestState: 'open', waitingOn: 'its pull request: checks and the merge', failedJobId: undefined });
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

/** The item after a read of GitHub; undefined: it says nothing new. A read of the issue older than the item's newest event is old news. */
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
  const next: Base = { ...base, issueState };
  if (issueReason) next.issueReason = issueReason;
  else delete next.issueReason;
  return settled(item, next, read.at);
}

/** How many items are in each state: every view's count. */
export function countStates(items: Iterable<Pick<WorkItem, 'state'>>): Record<WorkItemState, number> {
  const out = Object.fromEntries(WORK_ITEM_STATES.map((s) => [s, 0])) as Record<WorkItemState, number>;
  for (const i of items) out[i.state]++;
  return out;
}

/** The ledger: each item's row, and the counts every view reads. */
export interface WorkItemLedger {
  /** Fold one appended event into its item. Called by the event log in the append's transaction. */
  applyEvent(event: DomainEvent): void;
  /** Fold what a read of the issue graph said of issues and pull requests into their items. Called in the read's transaction. */
  applyNodes(nodes: readonly GraphNode[], readAt: string): void;
  get(key: string): WorkItem | undefined;
  /** The item whose pull request is `url` (issue #1074: a job's repo query of it); undefined: none. */
  byPullRequest(url: string): WorkItem | undefined;
  list(filter?: { state?: WorkItemState[]; limit?: number }): WorkItem[];
  /** How many items are in each state: `SELECT state, count(*)`. */
  counts(): Record<WorkItemState, number>;
  /** Replay every event and the issue graph through the reducer, in place of the rows there are. How many items. */
  rebuild(): number;
}
