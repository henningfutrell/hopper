// Labels mirror the database (issue #1891, design.md "The item lifecycle"): the end labels an issue should carry are a
// pure function of its work item's state (`labelsFor`), and what a discover saw on the issue is compared with them
// (`labelDrift`). The ledger is the truth; GitHub's labels follow it. Only the states whose end labels are certain are
// judged: an item a job works (queued, working, waiting outside) carries none; an item in PR open carries
// `hopper:pr-ready`, or `hopper:partly-done` for a part (either is allowed; the one to add follows `part`, issue #1933); a blocked item carries `hopper:blocked`, or `hopper:pr-closed`
// when its pull request was closed without a merge; a failed item carries `hopper:failed` once its job's failure was reported
// as failed (`failureReported`, issue #1892): not while the hopper fixes it itself (issue #1230) or its report waits, and not a
// culprit whose merge was reverted (failed by its landing, not by its job); a done item carries `hopper:done` once its pull
// request merged as the whole item (`wholeMerged`): the follow put it on with the merge; or once a person resolved its hand-off as
// Done by hand (`doneByHand`): the resolution put it on. Not a done item a job's end or a read of GitHub made done: its report
// set the labels by what the issue said then. A partly done item carries none once its merged
// part leaves parts to run (`partsLeft`): the follow took `hopper:partly-done` off, so Intake takes it again and the next part
// runs. Not a last part that made every declared part done: the follow put `hopper:done` on. An item that needs a person carries
// none while its job waits on a question, a proposal, a research report or a pick-up of its parked job: no report wrote one.
// A hand-off (`HANDOFF_WAIT`) carries `hopper:failed` once its job's failure was reported as failed (`failureReported`), as a
// failed item does: its job failed, and the hand-off waits on a person; before, the labels decide. A request card (waiting for
// approval) carries none: it has no job yet, and no report wrote one. An end label a person puts on a card by hand is their
// withdraw of it (`labelPutOn`), never read back as state. An item a person dropped by Won't do (`wontDo`: a blocked item in
// Intake, or a hand-off) carries `hopper:rejected`: the act put it on. Not an item dropped any other way (cancelled, declined,
// dismissed, Close PR, closed as not planned): what its issue carries then is not certain. Every other state is not judged.
// Pure: no I/O, no clock.
import { RECONCILE_GRACE_MS, type BlockedCause } from '../../domain/item-lifecycle.ts';
import { HANDOFF_WAIT, type WorkItem, type WorkItemState } from '../../domain/work-items.ts';
import { END_LABELS, LABEL_BLOCKED, LABEL_DONE, LABEL_FAILED, LABEL_PARTLY_DONE, LABEL_PR_CLOSED, LABEL_PR_READY, LABEL_REJECTED } from './labels.ts';

/** The end labels an item's state allows, and the one to add when none of them is on (absent: none is needed). */
export interface WantedLabels { allowed: readonly string[]; add?: string }

/**
 * Of an item in PR open: whether its open pull request is a part (`hopper:partly-done`, not `hopper:pr-ready`). Of a failed
 * item or a hand-off: whether its job's failure was reported to its issue as failed (`hopper:failed`). Of a partly done item: whether the
 * follow recorded its part's merge and parts are left to run (no end label; not when every declared part is done).
 */
export interface LabelFacts { part?: boolean; failureReported?: boolean; partsLeft?: boolean }

/** What the labels of an item are judged by: its state, its block's cause, whether its events alone put it there, its merge, and what it waits on. */
export type LabelledItem = Pick<WorkItem, 'state' | 'blockedCause'> & Partial<Pick<WorkItem, 'eventState' | 'pullRequestState' | 'wholeMerged' | 'waitingOn' | 'wontDo' | 'doneByHand'>>;

/** The end labels `item`'s state wants on its issue; undefined: the state is not judged. */
export function labelsFor(item: LabelledItem, facts: LabelFacts = {}): WantedLabels | undefined {
  switch (item.state) {
    case 'waiting_for_approval': case 'queued': case 'working': case 'waiting_outside': return { allowed: [] };
    case 'pr_open': return { allowed: [LABEL_PR_READY, LABEL_PARTLY_DONE], add: facts.part ? LABEL_PARTLY_DONE : LABEL_PR_READY };
    case 'blocked': {
      const label = item.blockedCause === 'pr_closed' ? LABEL_PR_CLOSED : LABEL_BLOCKED;
      return { allowed: [label], add: label };
    }
    case 'failed': return item.eventState === 'failed' && facts.failureReported ? { allowed: [LABEL_FAILED], add: LABEL_FAILED } : undefined;
    case 'done': return (item.pullRequestState === 'merged' && item.wholeMerged === true) || (item.eventState === 'done' && item.doneByHand === true) ? { allowed: [LABEL_DONE], add: LABEL_DONE } : undefined;
    case 'partly_done': return item.eventState === 'partly_done' && facts.partsLeft ? { allowed: [] } : undefined;
    case 'needs_you':
      if (item.waitingOn === HANDOFF_WAIT) return facts.failureReported ? { allowed: [LABEL_FAILED], add: LABEL_FAILED } : undefined;
      return item.waitingOn !== undefined ? { allowed: [] } : undefined;
    case 'dropped': return item.eventState === 'dropped' && item.wontDo === true ? { allowed: [LABEL_REJECTED], add: LABEL_REJECTED } : undefined;
    default: return undefined;
  }
}

/**
 * Whether `item` is a hand-off that moved within the reconciler's grace before `now` (issue #1892): the label mirror and
 * the label edit check do not judge it yet, so Intake does not read the ledger for it either; its labels decide. A person
 * who takes `hopper:failed` off it in that time gets a Run again, as before the hand-off was judged.
 */
export const handoffSettling = (item: Pick<WorkItem, 'state' | 'waitingOn' | 'eventAt'> | undefined, now: number): boolean =>
  item?.state === 'needs_you' && item.waitingOn === HANDOFF_WAIT && Date.parse(item.eventAt) > now - RECONCILE_GRACE_MS;

/**
 * The label change of a block the item reconciler makes (part 8): the end labels the state it leaves may have put on
 * (PR open's, or partly done's `hopper:partly-done`) come off, and the blocked state's goes on. Written with no read of
 * the issue's labels: a remove of a label the issue does not carry changes nothing.
 */
export function blockLabels(from: WorkItemState, cause: BlockedCause): { remove: string[]; add: string[] } {
  const add = labelsFor({ state: 'blocked', blockedCause: cause })!.add!;
  const left = from === 'partly_done' ? [LABEL_PARTLY_DONE] : labelsFor({ state: from })?.allowed ?? [];
  return { remove: left.filter((l) => l !== add), add: [add] };
}

/**
 * How the end labels `seen` on the issue differ from what `item`'s state wants: the end labels to take off, and the one to
 * put on when none it allows is on. Undefined: no drift, or the state is not judged.
 */
export interface LabelDrift { remove: string[]; add: string[] }

export function labelDrift(item: LabelledItem, seen: readonly string[], facts: LabelFacts = {}): LabelDrift | undefined {
  const want = labelsFor(item, facts);
  if (!want) return undefined;
  const ends = seen.filter((l) => END_LABELS.includes(l));
  const remove = ends.filter((l) => !want.allowed.includes(l));
  const missing = want.add !== undefined && !ends.some((l) => want.allowed.includes(l));
  const add = missing ? [want.add!] : [];
  return remove.length || add.length ? { remove, add } : undefined;
}

/**
 * How a follow of a job's pull request ends for its item (issue #1892 part 14): merged as the whole item (or its last part),
 * a part merged with parts left, closed without a merge, a blocked item's pull request found open, or abandoned (the issue
 * closed as not planned).
 */
export type FollowEnd = { end: 'merged' | 'part_merged' | 'closed' | 'abandoned' } | { end: 'found_open'; part: boolean };

/** The waiting labels an abandoned follow takes off: dropped is a state the ledger does not judge, so none goes on. */
const ABANDONED_OFF: readonly string[] = [LABEL_PR_READY, LABEL_PARTLY_DONE, LABEL_FAILED, LABEL_BLOCKED];

/**
 * The label change of a follow's end on an issue that carries `carried` (issue #1892 part 14): the drift of the state the
 * end moves the item to, as `labelsFor` names it. Undefined: the issue carries what that state wants.
 */
export function followLabels(f: FollowEnd, carried: readonly string[]): LabelDrift | undefined {
  if (f.end === 'abandoned') {
    const remove = carried.filter((l) => ABANDONED_OFF.includes(l));
    return remove.length ? { remove, add: [] } : undefined;
  }
  if (f.end === 'found_open') return labelDrift({ state: 'pr_open' }, carried, { part: f.part });
  const [item, facts]: [LabelledItem, LabelFacts] = f.end === 'merged' ? [{ state: 'done', pullRequestState: 'merged', wholeMerged: true }, {}]
    : f.end === 'part_merged' ? [{ state: 'partly_done', eventState: 'partly_done' }, { partsLeft: true }]
      : [{ state: 'blocked', blockedCause: 'pr_closed' }, {}];
  return labelDrift(item, carried, facts);
}

/** One line for the log: the item's state and how its labels differ. */
export const driftWords = (item: LabelledItem, d: LabelDrift): string =>
  `${item.state}${item.blockedCause ? ` (${item.blockedCause})` : ''}: ${[
    ...(d.remove.length ? [`${d.remove.join(', ')} on the issue`] : []),
    ...(d.add.length ? [`${d.add.join(', ')} not on the issue`] : []),
  ].join('; ')}`;

/**
 * The end label a person took off the issue by hand (issue #1892): `item`'s state wants one of its labels on (PR open,
 * blocked, failed or handed off as reported, dropped by Won't do), one of them was on at the last discover (`before`), and none is on now. Undefined: no such edit — no label was
 * seen before (never read back as state), one is still on (a swap of PR open's waiting labels is none), or the state wants
 * no label. Whether the item moved since, or the hopper's own write took it off, the caller judges.
 */
export function labelTakenOff(item: LabelledItem, before: readonly string[], now: readonly string[], facts: LabelFacts = {}): string | undefined {
  const want = labelsFor(item, facts);
  if (want?.add === undefined || now.some((l) => want.allowed.includes(l))) return undefined;
  return before.find((l) => want.allowed.includes(l));
}

/**
 * The end label a person put on a request card by hand (issue #1892): `item` waits for approval, and an end label not on the
 * issue at the last discover (`before`) is on now. It withdraws the card; the label stays. Undefined: no such edit. Whether
 * the item moved since, the caller judges.
 */
export function labelPutOn(item: LabelledItem, before: readonly string[], now: readonly string[]): string | undefined {
  if (item.state !== 'waiting_for_approval') return undefined;
  return now.find((l) => END_LABELS.includes(l) && !before.includes(l));
}
