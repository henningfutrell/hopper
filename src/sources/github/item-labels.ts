// Labels mirror the database (issue #1891, design.md "The item lifecycle"): the end labels an issue should carry are a
// pure function of its work item's state (`labelsFor`), and what a discover saw on the issue is compared with them
// (`labelDrift`). The ledger is the truth; GitHub's labels follow it. Only the states whose end labels are certain are
// judged: an item a job works (queued, working, waiting outside) carries none; an item in PR open carries
// `hopper:pr-ready`, or `hopper:partly-done` for a part (either is allowed; the one to add follows `part`, issue #1933); a blocked item carries `hopper:blocked`, or `hopper:pr-closed`
// when its pull request was closed without a merge; a failed item carries `hopper:failed` once its job's failure was reported
// as failed (`failureReported`, issue #1892): not while the hopper fixes it itself (issue #1230) or its report waits, and not a
// culprit whose merge was reverted (failed by its landing, not by its job); a done item carries `hopper:done` once its pull
// request merged as the whole item (`wholeMerged`): the follow put it on with the merge. Not a done item a job's end or a read
// of GitHub made done: its report set the labels by what the issue said then. A partly done item carries none once its merged
// part leaves parts to run (`partsLeft`): the follow took `hopper:partly-done` off, so Intake takes it again and the next part
// runs. Not a last part that made every declared part done: the follow put `hopper:done` on. Every other state is not judged.
// Pure: no I/O, no clock.
import type { BlockedCause } from '../../domain/item-lifecycle.ts';
import type { WorkItem, WorkItemState } from '../../domain/work-items.ts';
import { END_LABELS, LABEL_BLOCKED, LABEL_DONE, LABEL_FAILED, LABEL_PARTLY_DONE, LABEL_PR_CLOSED, LABEL_PR_READY } from './labels.ts';

/** The end labels an item's state allows, and the one to add when none of them is on (absent: none is needed). */
export interface WantedLabels { allowed: readonly string[]; add?: string }

/**
 * Of an item in PR open: whether its open pull request is a part (`hopper:partly-done`, not `hopper:pr-ready`). Of a failed
 * item: whether its job's failure was reported to its issue as failed (`hopper:failed`). Of a partly done item: whether the
 * follow recorded its part's merge and parts are left to run (no end label; not when every declared part is done).
 */
export interface LabelFacts { part?: boolean; failureReported?: boolean; partsLeft?: boolean }

/** What the labels of an item are judged by: its state, its block's cause, whether its events alone put it there, and its merge. */
export type LabelledItem = Pick<WorkItem, 'state' | 'blockedCause'> & Partial<Pick<WorkItem, 'eventState' | 'pullRequestState' | 'wholeMerged'>>;

/** The end labels `item`'s state wants on its issue; undefined: the state is not judged. */
export function labelsFor(item: LabelledItem, facts: LabelFacts = {}): WantedLabels | undefined {
  switch (item.state) {
    case 'queued': case 'working': case 'waiting_outside': return { allowed: [] };
    case 'pr_open': return { allowed: [LABEL_PR_READY, LABEL_PARTLY_DONE], add: facts.part ? LABEL_PARTLY_DONE : LABEL_PR_READY };
    case 'blocked': {
      const label = item.blockedCause === 'pr_closed' ? LABEL_PR_CLOSED : LABEL_BLOCKED;
      return { allowed: [label], add: label };
    }
    case 'failed': return item.eventState === 'failed' && facts.failureReported ? { allowed: [LABEL_FAILED], add: LABEL_FAILED } : undefined;
    case 'done': return item.pullRequestState === 'merged' && item.wholeMerged === true ? { allowed: [LABEL_DONE], add: LABEL_DONE } : undefined;
    case 'partly_done': return item.eventState === 'partly_done' && facts.partsLeft ? { allowed: [] } : undefined;
    default: return undefined;
  }
}

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

/** One line for the log: the item's state and how its labels differ. */
export const driftWords = (item: LabelledItem, d: LabelDrift): string =>
  `${item.state}${item.blockedCause ? ` (${item.blockedCause})` : ''}: ${[
    ...(d.remove.length ? [`${d.remove.join(', ')} on the issue`] : []),
    ...(d.add.length ? [`${d.add.join(', ')} not on the issue`] : []),
  ].join('; ')}`;

/**
 * The end label a person took off the issue by hand (issue #1892): `item`'s state wants one of its labels on (PR open,
 * blocked, failed as reported), one of them was on at the last discover (`before`), and none is on now. Undefined: no such edit — no label was
 * seen before (never read back as state), one is still on (a swap of PR open's waiting labels is none), or the state wants
 * no label. Whether the item moved since, or the hopper's own write took it off, the caller judges.
 */
export function labelTakenOff(item: LabelledItem, before: readonly string[], now: readonly string[], facts: LabelFacts = {}): string | undefined {
  const want = labelsFor(item, facts);
  if (want?.add === undefined || now.some((l) => want.allowed.includes(l))) return undefined;
  return before.find((l) => want.allowed.includes(l));
}
