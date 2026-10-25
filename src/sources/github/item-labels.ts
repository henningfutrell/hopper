// Labels mirror the database (issue #1891, design.md "The item lifecycle"): the end labels an issue should carry are a
// pure function of its work item's state (`labelsFor`), and what a discover saw on the issue is compared with them
// (`labelDrift`). The ledger is the truth; GitHub's labels follow it. Only the states whose end labels are certain are
// judged: an item a job works (queued, working, waiting outside) carries none; an item in PR open carries
// `hopper:pr-ready`, or `hopper:partly-done` for a part (either is allowed; the one to add follows `part`, issue #1933), and
// only `hopper:needs-merge` while its pull request is in a repository the hopper does not merge in (`needsMerge`, issue #2752); a blocked item carries `hopper:blocked`, or `hopper:pr-closed`
// when its pull request was closed without a merge, or none when it is blocked for want of a pull request (issue #2693: the
// hopper looks for it and runs the item again, so no pull request found is no resting state and no label says so); a failed item carries `hopper:failed` once its job's failure was reported
// as failed (`failureReported`, issue #1892): not while the hopper fixes it itself (issue #1230) or its report waits; a
// culprit whose merge was reverted (failed by its landing, not by its job: its events say done, issue #1175) carries
// `hopper:done` when it merged as the whole item (part 33): the follow put it on at the merge, the red batch writes no label to
// its issue and no batch run closed it; a culprit that was a part with parts left (`partsLeft`, part 34) carries none: the follow
// took `hopper:partly-done` off at its merge; a culprit that was the last part (`lastPartMerged`, part 35) carries `hopper:done`:
// the follow put it on with that merge; a failed item whose failure was told as one the
// hopper fixes itself (`fixingReported`, issue #1230, part 31) carries none: that report left the issue as it was, and while
// its job worked the mirror kept every end label off; a failed item whose report waits (`failureReportWaits`, part 32) may
// carry `hopper:failed` and no other end label: the report puts it on, or leaves the issue as it was, so none is put on before
// it; a done item carries `hopper:done` once its pull
// request merged as the whole item (`wholeMerged`): the follow put it on with the merge; or once a person resolved its hand-off as
// Done by hand (`doneByHand`): the resolution put it on; or once a job's end made it done and its job's final report found
// the issue closed as complete (`doneReported`, part 24): the report put it on. A done item a job's end made while its issue
// was open carries what its job's final report put on (`doneReported`, part 28): `hopper:pr-ready`, or `hopper:partly-done`
// for a part, while the pull request it follows waits; none while it found none (issue #2693). Not a done item a read of GitHub
// made done. A partly done item carries none once its merged
// part leaves parts to run (`partsLeft`): the follow took `hopper:partly-done` off, so Intake takes it again and the next part
// runs. A partly done item whose merged part made every declared part done (`lastPartMerged`, part 35) carries `hopper:done`:
// the follow put it on with that merge. The follow is that of the job that recorded the merge, also an older job's (part 37). An item that needs a person carries
// `hopper:needs-decision` while its job waits on a person's decision — a question, a proposal or a research report, parked by
// itself there or not (issue #2693) —, and none while it waits on a pick-up of its parked job: no report wrote one.
// A hand-off (`HANDOFF_WAIT`) carries `hopper:failed` once its job's failure was reported as failed (`failureReported`), as a
// failed item does: its job failed, and the hand-off waits on a person; before, the labels decide. A request card (waiting for
// approval) carries none: it has no job yet, and no report wrote one. An end label a person puts on a card by hand is their
// withdraw of it (`labelPutOn`), never read back as state. An item a person dropped by Won't do (`wontDo`: a blocked item in
// Intake, or a hand-off) carries `hopper:rejected`: the act put it on. An item a cancelled or rejected job dropped carries none
// once its report went out (`dropReported`, part 19): the report took only the claim off, and while its job worked the mirror
// kept every end label off. A tend job cancelled by no person and no source carries `hopper:pr-ready` once reported (part 23):
// its report put it back, as its pull request waits to be tended again. An end label a person puts on such an
// item by hand (`labelPutOn`) keeps the issue out (`keptOut`): the item then carries that label. An item dropped by the dismiss
// of its failed job's locked entry (`dismissed`, part 20) carries `hopper:failed` once its job's failure was reported as failed
// (`failureReported`): the dismiss writes no label, so the issue keeps the report's. An item dropped by a person's Close PR
// (`closedByPerson`, part 21) carries `hopper:pr-closed`: the follow of the close put it on, as for a close on GitHub. So does
// an item the hopper's own close dropped while its issue is open (`closedByHopper`, part 22: housekeeping closed its pull
// request with nothing left to land). Not an item dropped any other way (declined, closed as not planned): what its issue
// carries then is not certain. Every other state is not judged.
// Pure: no I/O, no clock.
import { RECONCILE_GRACE_MS, type BlockedCause } from '../../domain/item-lifecycle.ts';
import { DECISION_WAITS, HANDOFF_WAIT, type WorkItem, type WorkItemState } from '../../domain/work-items.ts';
import { DELIBERATE_CANCELS, pullRequestRepo, type Job } from '../../domain/types.ts';
import { END_LABELS, LABEL_BLOCKED, LABEL_DONE, LABEL_FAILED, LABEL_NEEDS_DECISION, LABEL_NEEDS_MERGE, LABEL_PARTLY_DONE, LABEL_PR_CLOSED, LABEL_PR_READY, LABEL_REJECTED } from './labels.ts';

/** The end labels an item's state allows, and the one to add when none of them is on (absent: none is needed). */
export interface WantedLabels { allowed: readonly string[]; add?: string }

/**
 * Of an item in PR open: whether its open pull request is a part (`hopper:partly-done`, not `hopper:pr-ready`). Of a failed
 * item, a hand-off or an item a dismiss dropped: whether its job's failure was reported to its issue as failed (`hopper:failed`). Of a partly done item: whether the
 * follow (of the job that recorded the merge, part 37) recorded its part's merge and parts are left to run (no end label; not when every declared part is done), and so of
 * a reverted culprit of a part; or whether that merge made every declared part done (`lastPartMerged`, `hopper:done`). Of a done
 * item: what its job's final report put on (`doneReported`). Of a failed item: whether its job's failure was reported as one
 * the hopper fixes itself (`fixingReported`, no end label), or its report is not out yet (`failureReportWaits`). Of an item in
 * PR open, or a done item whose report found its pull request waiting: whether that pull request is in a repository the hopper
 * does not merge in (`needsMerge`, issue #2752: `hopper:needs-merge`).
 */
export interface LabelFacts { needsMerge?: boolean; part?: boolean; failureReported?: boolean; fixingReported?: boolean; failureReportWaits?: boolean; partsLeft?: boolean; lastPartMerged?: boolean; dropReported?: DropReport; doneReported?: DoneReport }

/**
 * What the final report of a finished job put on its issue (issue #1892 parts 24, 28): `closed`, the issue was closed as
 * complete, `hopper:done`; else the issue was open and the report follows it: `pr_open`, its pull request waits,
 * `hopper:pr-ready`; `part`, a part's, `hopper:partly-done`; `no_pr`, none is open, no end label (issue #2693).
 */
export type DoneReport = 'closed' | 'pr_open' | 'part' | 'no_pr';

/**
 * What the final report of a dropped item's cancelled or rejected job left on its issue: `none`, only the claim came off
 * (issue #1892 part 19); `pr_ready`, a tend job cancelled not on purpose put `hopper:pr-ready` back (part 23).
 */
export type DropReport = 'none' | 'pr_ready';

/** A tend job (issue #967) cancelled by no person and no source (issue #1010): `tendRetryAt` tends its pull request again. */
export const tendTriedAgain = (job: Pick<Job, 'spec' | 'sourceState'>): boolean => {
  const reason = job.sourceState?.sync?.cancelReason;
  return job.spec.tend === true && !(typeof reason === 'string' && DELIBERATE_CANCELS.includes(reason));
};

/**
 * Of a dropped item's job: what its final report left (`DropReport`), once the job was cancelled or rejected and the
 * report went out. Undefined: not such a job, or its report not out yet.
 */
export const dropReported = (job: Pick<Job, 'status' | 'spec' | 'sourceState'> | undefined): DropReport | undefined => {
  if ((job?.status !== 'cancelled' && job?.status !== 'rejected') || job.sourceState?.sync?.finalReported !== true) return undefined;
  return job.status === 'cancelled' && tendTriedAgain(job) ? 'pr_ready' : 'none';
};

/**
 * Of a done item's job: what its final report put on (`DoneReport`), once it finished and the report went out. The report's
 * source state keeps `doneReported` for an issue closed as complete (part 24); for an open one, the pull request it follows
 * (part 28): while the follow is open, the one it follows, or none yet. A follow found one since: its labels follow it too.
 * Undefined: not such a job, its report not out yet, or its follow ended (the follow's end moves the item).
 */
export const doneReported = (job: Pick<Job, 'status' | 'sourceState'> | undefined): DoneReport | undefined => {
  if (job?.status !== 'finished' || job.sourceState?.sync?.finalReported !== true) return undefined;
  const s = job.sourceState?.source as { doneReported?: boolean; follow?: string; pullRequest?: string; part?: boolean } | undefined;
  if (s?.doneReported === true) return 'closed';
  if (s?.follow !== 'open') return undefined;
  return s.pullRequest === undefined ? 'no_pr' : s.part === true ? 'part' : 'pr_open';
};

/** What the labels of an item are judged by: its state, its block's cause, whether its events alone put it there, its merge, and what it waits on. */
export type LabelledItem = Pick<WorkItem, 'state' | 'blockedCause'> & Partial<Pick<WorkItem, 'eventState' | 'pullRequestState' | 'wholeMerged' | 'waitingOn' | 'wontDo' | 'keptOut' | 'dismissed' | 'closedByPerson' | 'closedByHopper' | 'doneByHand'>>;

/** The end labels `item`'s state wants on its issue; undefined: the state is not judged. */
export function labelsFor(item: LabelledItem, facts: LabelFacts = {}): WantedLabels | undefined {
  switch (item.state) {
    case 'waiting_for_approval': case 'queued': case 'working': case 'waiting_outside': return { allowed: [] };
    case 'pr_open':
      if (facts.needsMerge) return { allowed: [LABEL_NEEDS_MERGE], add: LABEL_NEEDS_MERGE };
      return { allowed: [LABEL_PR_READY, LABEL_PARTLY_DONE], add: facts.part ? LABEL_PARTLY_DONE : LABEL_PR_READY };
    case 'blocked': {
      if (item.blockedCause === 'no_pr') return { allowed: [] };
      const label = item.blockedCause === 'pr_closed' ? LABEL_PR_CLOSED : LABEL_BLOCKED;
      return { allowed: [label], add: label };
    }
    case 'failed':
      // A reverted culprit of a whole merge (part 33): its events say done; the follow put `hopper:done` on at the merge.
      if (item.eventState === 'done' && item.pullRequestState === 'merged' && item.wholeMerged === true) return { allowed: [LABEL_DONE], add: LABEL_DONE };
      // A reverted culprit of a part with parts left (part 34): the follow took `hopper:partly-done` off at its merge.
      if (item.eventState === 'partly_done' && item.pullRequestState === 'merged' && facts.partsLeft) return { allowed: [] };
      // A reverted culprit of the last part (part 35): the follow put `hopper:done` on with that merge.
      if (item.eventState === 'partly_done' && item.pullRequestState === 'merged' && facts.lastPartMerged) return { allowed: [LABEL_DONE], add: LABEL_DONE };
      if (item.eventState !== 'failed') return undefined;
      if (facts.failureReported) return { allowed: [LABEL_FAILED], add: LABEL_FAILED };
      return facts.fixingReported ? { allowed: [] } : facts.failureReportWaits ? { allowed: [LABEL_FAILED] } : undefined;
    case 'done': {
      if ((item.pullRequestState === 'merged' && item.wholeMerged === true) || (item.eventState === 'done' && (item.doneByHand === true || facts.doneReported === 'closed'))) return { allowed: [LABEL_DONE], add: LABEL_DONE };
      if (item.eventState !== 'done' || facts.doneReported === undefined) return undefined;
      return facts.doneReported === 'no_pr' ? labelsFor({ state: 'blocked', blockedCause: 'no_pr' }) : labelsFor({ state: 'pr_open' }, { part: facts.doneReported === 'part', ...(facts.needsMerge ? { needsMerge: true } : {}) });
    }
    case 'partly_done': return item.eventState !== 'partly_done' ? undefined : facts.partsLeft ? { allowed: [] } : facts.lastPartMerged ? { allowed: [LABEL_DONE], add: LABEL_DONE } : undefined;
    case 'needs_you':
      if (item.waitingOn === HANDOFF_WAIT) return facts.failureReported ? { allowed: [LABEL_FAILED], add: LABEL_FAILED } : undefined;
      if (DECISION_WAITS.includes(item.waitingOn ?? '')) return { allowed: [LABEL_NEEDS_DECISION], add: LABEL_NEEDS_DECISION };
      return item.waitingOn !== undefined ? { allowed: [] } : undefined;
    case 'dropped': {
      if (item.eventState !== 'dropped') return undefined;
      const label = item.wontDo === true ? LABEL_REJECTED : item.closedByPerson === true || item.closedByHopper === true ? LABEL_PR_CLOSED : item.keptOut;
      if (label !== undefined) return { allowed: [label], add: label };
      if (item.dismissed === true) return facts.failureReported ? { allowed: [LABEL_FAILED], add: LABEL_FAILED } : undefined;
      if (facts.dropReported === 'pr_ready') return { allowed: [LABEL_PR_READY], add: LABEL_PR_READY };
      return facts.dropReported === 'none' ? { allowed: [] } : undefined;
    }
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
 * (PR open's, or partly done's `hopper:partly-done`) come off, and the blocked state's goes on (none for want of a pull request, issue #2693). Written with no read of
 * the issue's labels: a remove of a label the issue does not carry changes nothing.
 */
export function blockLabels(from: WorkItemState, cause: BlockedCause): { remove: string[]; add: string[] } {
  const add = labelsFor({ state: 'blocked', blockedCause: cause })!.add;
  const left = from === 'partly_done' ? [LABEL_PARTLY_DONE] : from === 'pr_open' ? [LABEL_PR_READY, LABEL_PARTLY_DONE, LABEL_NEEDS_MERGE] : labelsFor({ state: from })?.allowed ?? [];
  return { remove: left.filter((l) => l !== add), add: add ? [add] : [] };
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
 * Whether the pull request found open for job `jobId` ends its item's block for want of one (issue #1891), so its issue
 * gets PR open's labels: the ledger says so (issue #1892 part 27) — blocked with no pull request, or done by its end with
 * none found (part 28), by this job, no Run again asked —; the issue's `hopper:blocked` only for an item the ledger does not know or a state the mirror does not judge.
 */
export function blockedForPullRequest(item: (LabelledItem & Pick<WorkItem, 'jobId' | 'runAgainAsked'>) | undefined, jobId: string, carried: readonly string[]): boolean {
  // Done by this job's end, its report found none open (part 28): it put `hopper:blocked` on, and the follow looks again.
  const reportedNone = item?.state === 'done' && item.eventState === 'done' && item.doneByHand !== true && item.wholeMerged !== true;
  if (item === undefined || (labelsFor(item) === undefined && !reportedNone)) return carried.includes(LABEL_BLOCKED);
  return (reportedNone || (item.state === 'blocked' && item.blockedCause === 'no_pr')) && item.jobId === jobId && item.runAgainAsked === undefined;
}

/**
 * How a follow of a job's pull request ends for its item (issue #1892 part 14): merged as the whole item (or its last part),
 * a part merged with parts left, closed without a merge, a blocked item's pull request found open, or abandoned (the issue
 * closed as not planned).
 */
export type FollowEnd = { end: 'merged' | 'part_merged' | 'closed' | 'abandoned' } | { end: 'found_open'; part: boolean; needsMerge?: boolean };

/** The waiting labels an abandoned follow takes off: dropped is a state the ledger does not judge, so none goes on. */
const ABANDONED_OFF: readonly string[] = [LABEL_PR_READY, LABEL_PARTLY_DONE, LABEL_NEEDS_MERGE, LABEL_FAILED, LABEL_BLOCKED];

/**
 * The label change of a follow's end on an issue that carries `carried` (issue #1892 part 14): the drift of the state the
 * end moves the item to, as `labelsFor` names it. Undefined: the issue carries what that state wants.
 */
export function followLabels(f: FollowEnd, carried: readonly string[]): LabelDrift | undefined {
  if (f.end === 'abandoned') {
    const remove = carried.filter((l) => ABANDONED_OFF.includes(l));
    return remove.length ? { remove, add: [] } : undefined;
  }
  if (f.end === 'found_open') return labelDrift({ state: 'pr_open' }, carried, { part: f.part, ...(f.needsMerge ? { needsMerge: true } : {}) });
  const [item, facts]: [LabelledItem, LabelFacts] = f.end === 'merged' ? [{ state: 'done', pullRequestState: 'merged', wholeMerged: true }, {}]
    : f.end === 'part_merged' ? [{ state: 'partly_done', eventState: 'partly_done' }, { partsLeft: true }]
      : [{ state: 'blocked', blockedCause: 'pr_closed' }, {}];
  return labelDrift(item, carried, facts);
}

/**
 * How a job's report ends its item (issue #1892 part 15): its pull request waits (PR open, a whole or a part), no pull
 * request is open (blocked), the issue was closed as complete, the job failed, or it was cancelled (a tend job cancelled by
 * no person: its pull request waits again) or rejected at the queue gate.
 */
export type ReportEnd = { end: 'pr_open'; part: boolean; needsMerge?: boolean } | { end: 'no_pr' | 'closed' | 'failed' | 'rejected' } | { end: 'cancelled'; tendAgain: boolean };

/** Whether pull request `url` of an issue in `repo` is in a repository the hopper does not merge in (issue #2752): `hopper:needs-merge`, not `hopper:pr-ready`. */
export const needsMergeOf = (ctx: { needsMerge?(repo: string): boolean }, url: string, repo: string): boolean => ctx.needsMerge?.(pullRequestRepo(url, repo)) ?? false;

/** The end label a report's end puts on: of the state it moves the item to, as `labelsFor` names it. */
function reportAdd(r: ReportEnd): string | undefined {
  switch (r.end) {
    case 'pr_open': return labelsFor({ state: 'pr_open' }, { part: r.part, ...(r.needsMerge ? { needsMerge: true } : {}) })!.add;
    case 'no_pr': return labelsFor({ state: 'blocked', blockedCause: 'no_pr' })!.add;
    // A done item is judged only by its merge or a hand-off done by hand; an issue closed as complete is done all the same.
    case 'closed': return LABEL_DONE;
    case 'failed': return labelsFor({ state: 'failed', eventState: 'failed' }, { failureReported: true })!.add;
    case 'cancelled': return r.tendAgain ? labelsFor({ state: 'pr_open' })!.add : undefined;
    case 'rejected': return undefined;
  }
}

/**
 * The end label change of a report's end (issue #1892 part 15). With `carried`, the issue's labels as just read: every end
 * label the state does not want comes off, and one it carries is not added again. Without it, only the label goes on.
 */
export function reportLabels(r: ReportEnd, carried?: readonly string[]): LabelDrift {
  const add = reportAdd(r);
  if (!carried) return { remove: [], add: add ? [add] : [] };
  return { remove: carried.filter((l) => END_LABELS.includes(l) && l !== add), add: add && !carried.includes(add) ? [add] : [] };
}

/** One line for the log: the item's state and how its labels differ. */
export const driftWords = (item: LabelledItem, d: LabelDrift): string =>
  `${item.state}${item.blockedCause ? ` (${item.blockedCause})` : ''}: ${[
    ...(d.remove.length ? [`${d.remove.join(', ')} on the issue`] : []),
    ...(d.add.length ? [`${d.add.join(', ')} not on the issue`] : []),
  ].join('; ')}`;

/**
 * The end label a person took off the issue by hand (issue #1892): `item`'s state wants one of its labels on (PR open,
 * blocked, failed or handed off as reported, dropped by Won't do, a person's Close PR or the hopper's own close, or kept out by a label a person put on), one of them was on at the last discover (`before`), and none is on now. Undefined: no such edit — no label was
 * seen before (never read back as state), one is still on (a swap of PR open's waiting labels is none), or the state wants
 * no label. Whether the item moved since, or the hopper's own write took it off, the caller judges.
 */
export function labelTakenOff(item: LabelledItem, before: readonly string[], now: readonly string[], facts: LabelFacts = {}): string | undefined {
  const want = labelsFor(item, facts);
  // The decision label (issue #2693) says only what the job waits on: taken off, it asks for nothing.
  if (want?.add === undefined || want.add === LABEL_NEEDS_DECISION || now.some((l) => want.allowed.includes(l))) return undefined;
  return before.find((l) => want.allowed.includes(l));
}

/**
 * The end label a person put on by hand (issue #1892): `item` waits for approval, or a cancelled or rejected job dropped it
 * and it wants no end label (part 19), and an end label not on the issue at the last discover (`before`) is on now. On a card
 * it withdraws the card; on a dropped item it keeps the issue out. The label stays. Undefined: no such edit. Whether the item
 * moved since, the caller judges.
 */
export function labelPutOn(item: LabelledItem, before: readonly string[], now: readonly string[], facts: LabelFacts = {}): string | undefined {
  const keepsOut = item.state === 'dropped' && labelsFor(item, facts)?.allowed.length === 0;
  if (item.state !== 'waiting_for_approval' && !keepsOut) return undefined;
  return now.find((l) => END_LABELS.includes(l) && !before.includes(l));
}
