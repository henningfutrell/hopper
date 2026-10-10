// A hand-off's card (issue #621), pure: what happened, in plain sentences, from what the job's work shows at its
// source — the pull requests it opened or pushed to and its item — never from the raw error; and the one resolution to
// take, with why in a few words. The work shipped (a pull request merged, the item closed as completed): Done. The item
// closed any other way, or gone: Won't do. Else the pull request most worth a look decides: ready for review, Done;
// a draft or with merge conflicts, Continue; closed without a merge, Run again. No pull request: why it was handed off.
import { workShipped, type Handoff, type HandoffCard, type HandoffReason, type HandoffResolutionAction, type WorkPullRequest, type WorkState } from '../domain/types.ts';

/** How many pull requests the sentence names; more are counted. */
const NAMED = 2;

/** The order a pull request is worth a look in: merged, open and ready, open otherwise, closed. */
const rank = (pr: WorkPullRequest): number =>
  (pr.state === 'merged' ? 0 : pr.state === 'open' && !pr.draft && !pr.conflicting ? 1 : pr.state === 'open' ? 2 : 3);

function prState(pr: WorkPullRequest): string {
  if (pr.state === 'merged') return 'is merged';
  if (pr.state === 'closed') return 'is closed and not merged';
  if (pr.conflicting) return 'has merge conflicts';
  return pr.draft ? 'is a draft' : 'is open and ready for review';
}

const ITEM_TEXT: Record<WorkState['item'], string | undefined> = {
  open: undefined, done: 'The issue is done.', closed: 'The issue is closed and not done.', gone: 'The issue is gone.',
};

function whatHappened(w: WorkState, prs: WorkPullRequest[]): string {
  const parts = prs.slice(0, NAMED).map((pr) => `The job ${pr.by} PR #${pr.number}. #${pr.number} ${prState(pr)}.`);
  if (prs.length === 0) parts.push('The job stopped before it opened or updated a PR.');
  if (prs.length > NAMED) parts.push(`It has ${prs.length - NAMED} more PRs.`);
  const item = ITEM_TEXT[w.item] ?? (prs.some((pr) => pr.state === 'merged') ? 'The issue is still open.' : undefined);
  if (item) parts.push(item);
  return parts.join(' ');
}

/** No pull request to go by: the resolution for why it was handed off. */
function byReason(reason: HandoffReason, continueResumes: boolean): { recommended: HandoffResolutionAction; why: string } {
  switch (reason) {
    case 'person': return {
      recommended: 'continue',
      why: continueResumes ? 'Its session can go on. Tell it what to do in a note.' : 'A new job starts. It gets the error and your note.',
    };
    case 'retry_limit': return { recommended: 'fixed', why: 'It failed the same way each time. Fix the cause, then run it again.' };
    case 'auto_off': return { recommended: 'fixed', why: 'Automatic retry is off for this failure. Run it again when the cause is gone.' };
    case 'not_retried': return { recommended: 'fixed', why: 'The hopper could not run it again. Remove the block, then run it again.' };
    case 'dismissed': return { recommended: 'wont_do', why: 'It was removed from the queue with its failure open.' };
  }
}

function fromWork(w: WorkState, top: WorkPullRequest | undefined): Omit<HandoffCard, 'whatHappened'> | undefined {
  if (workShipped(w)) {
    const merged = top?.state === 'merged' ? top : undefined;
    return { recommended: 'done_by_hand', why: 'The work is done.', ...(merged ? { link: merged.url } : {}) };
  }
  if (w.item === 'closed' || w.item === 'gone') return { recommended: 'wont_do', why: `The issue is ${w.item === 'gone' ? 'gone' : 'closed'}. Nothing is left to do.` };
  if (!top) return undefined;
  if (top.state === 'closed') return { recommended: 'fixed', why: 'Its PR is closed. A new job can start again.' };
  if (top.conflicting) return { recommended: 'continue', why: 'The job can fix the conflicts.' };
  if (top.draft) return { recommended: 'continue', why: 'The job can finish the PR.' };
  return { recommended: 'done_by_hand', why: 'The PR is ready. Review and merge it.', link: top.url };
}

/** The card of a hand-off: from its work state when its source said one, else from why it was handed off. */
export function handoffCard(h: Pick<Handoff, 'reason' | 'work'> & { status?: Handoff['status'] }, continueResumes: boolean): HandoffCard {
  const w = h.work;
  if (!w) {
    const whatHappened = h.status === 'closed' ? 'The job stopped with an error.' : 'The job stopped with an error. The hopper is checking its PRs and its issue.';
    return { whatHappened, ...byReason(h.reason, continueResumes) };
  }
  const prs = w.pullRequests.map((pr, i) => ({ pr, i })).sort((a, b) => rank(a.pr) - rank(b.pr) || a.i - b.i).map((x) => x.pr);
  return { whatHappened: whatHappened(w, prs), ...(fromWork(w, prs[0]) ?? byReason(h.reason, continueResumes)) };
}
