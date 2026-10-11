// Following a done job's pull request after its end was reported (issue #579, design.md "Done is a pull request"). The
// report kept it in the job's source state (`pullRequest`, `follow: open`, `part` for a part). Merged — the issue
// closed as complete by it, or the pull request merged —: the item is done, `hopper:pr-ready` → `hopper:done`; a part's
// `hopper:partly-done` only comes off, so the issue is offered again and its next part runs. Closed without a merge:
// flagged, → `hopper:pr-closed`, which keeps the issue out until a person removes it. Still open (PR waiting, issue #637):
// what is seen of it — a draft, merge conflicts, its checks — is kept for the Pull requests list; and with yolo mode on for
// its repository, whatever its job's origin (issue #805; issue #652 merged only a job with one), the hopper merges it once it is ready: not a draft, no merge conflicts, and its checks passed — or it
// has none, and none started within a grace window after its last push (issue #677; issue #652 had it wait for ever). A
// refused merge is kept on it (`mergeError`) and asked again next sync: it never fails the job. A pull request the
// report could not name is looked for again each sync, and named once found (issue #677). A merge marks the item done
// only when it closes the issue (issue #721): the issue is closed as completed, or the merged pull request's body closes it
// with a closing keyword. Any other merge — a part, a mention, a pull request named for the issue only on its branch — is a
// part: the issue is offered again — unless it makes every part the issue declares done (issue #729, parts.ts): then the
// issue is done, `hopper:done`. A merge recorded as the whole item before that rule is checked once by the same rule
// (`mergeChecked`), and one that did not close the issue loses `hopper:done`. A throw is asked again on a later sync.
// A person's Merge now or Close PR (issue #677) takes the same path: merged whatever yolo mode and its checks say — GitHub
// still refuses a draft, merge conflicts or a required check —, or closed without a merge; a refusal throws to the person.
// Closing finishes the loop (issue #677): after the hopper's own merge — yolo mode or Merge now — of a pull request that
// did not close the issue and ships no part ("Part of #N"), the hopper closes the issue as completed, with one comment
// that links the pull request, and the item is done. A merge a person made on GitHub stays as issue #721 has it.
// Pull-based completion (issue #428): the item is resolved upstream, the hopper only follows. Closed as completed, it is
// merged, as above. Closed as not planned while its pull request is still open, or none is found yet: abandoned — followed
// no more, never merged, its pull request left as it is; the waiting labels come off and no end label goes on. A person's
// act still goes through. Reopened with that pull request open, reconciling follows it again (issue #763).

import { rechecksMerge, readyToMerge, type FollowUp, type Job, type PullRequestAct, type PullRequestSeen } from '../../domain/types.ts';
import type { Clock } from '../../domain/ports.ts';
import { SourceError } from '../../domain/ports.ts';
import { GitHubApiError, type GitHubApi } from './api.ts';
import { closesByKeyword, isClosedAsCompleted, isPartOf, namesIssue, worksOnAnotherIssue } from './completion.ts';
import { LABEL_DONE, LABEL_FAILED, LABEL_PARTLY_DONE, LABEL_PR_CLOSED, LABEL_PR_READY } from './labels.ts';
import { allPartsDone, partsOf } from './parts.ts';
import { ensureLabels, type ReportContext } from './report.ts';

interface Followed { pullRequest?: string; follow?: string; part?: boolean; seen?: PullRequestSeen; mergeChecked?: boolean }

/**
 * What following a pull request needs beyond the report's: whether the hopper may merge in a repository (yolo mode), and
 * the clock for the no-checks grace window (issue #677; absent: the system clock).
 */
export interface FollowContext extends ReportContext { yoloMode?: (repo: string) => boolean; clock?: Clock }

type PullState = 'open' | 'merged' | 'closed';

const numberOf = (url: string): number => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);

/**
 * The newest open pull request of the issue, in any state of review (issue #677: the report names only a ready one): one
 * that closes it, else one in its repository that mentions it (a part says "Part of #N"), else one on a branch named for it.
 */
async function openPullRequestOf(api: GitHubApi, repo: string, number: number): Promise<{ url: string; part: boolean } | undefined> {
  const newest = <P extends { createdAt: string }>(prs: P[]): P | undefined => [...prs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const closing = newest(await api.openClosingPullRequests(repo, number));
  if (closing) return { url: closing.url, part: false };
  const mention = newest((await api.referencingPullRequests(repo, number))
    .filter((pr) => pr.state === 'open' && pr.repo.toLowerCase() === repo.toLowerCase() && !worksOnAnotherIssue(pr.body, repo, number)));
  if (mention) return { url: mention.url, part: isPartOf(mention, repo, number) };
  const branch = newest((await api.openPullRequests(repo)).filter((pr) => namesIssue(pr.headRef, number)));
  return branch && { url: branch.url, part: false };
}

/** Where the pull request is now; undefined: it cannot be told yet (none named nor found, and nothing merged). */
async function stateOf(api: GitHubApi, repo: string, number: number, s: Followed): Promise<{ state: PullState; url: string } | undefined> {
  if (!s.part) {
    const closer = await api.closingPullRequest(repo, number);
    if (isClosedAsCompleted(await api.getIssue(repo, number), closer)) return { state: 'merged', url: closer?.url ?? s.pullRequest ?? '' };
  }
  if (!s.pullRequest) return undefined;
  const mention = (await api.referencingPullRequests(repo, number)).find((pr) => pr.url === s.pullRequest);
  if (mention) return s.part && !isPartOf(mention, repo, number) ? undefined : { state: mention.state, url: mention.url };
  // Not a mention (issue #637: a pull request named for the issue only on its branch): asked by its number.
  return { state: (await api.pullRequest(repo, numberOf(s.pullRequest)))?.state ?? 'closed', url: s.pullRequest };
}

/**
 * An open pull request: what is seen of it, and, yolo mode on and it ready, the hopper's merge. A person's act (issue
 * #677): merged or closed now, GitHub's refusal thrown.
 */
async function waiting(ctx: FollowContext, job: Job, url: string, before: PullRequestSeen | undefined, act?: PullRequestAct): Promise<{ ended: 'merged' | 'closed' } | { seen: PullRequestSeen }> {
  const repo = job.source!.repo!;
  if (act === 'close') {
    await ctx.api.closeWithoutMerge(repo, numberOf(url));
    return { ended: 'closed' };
  }
  if (act === 'merge') {
    await ctx.api.merge(repo, numberOf(url));
    return { ended: 'merged' };
  }
  const pr = await ctx.api.pullRequest(repo, numberOf(url));
  if (!pr) return { seen: before ?? { draft: false, conflicting: false, checks: 'none' } };
  const pushedAt = pr.headCommittedAt && pr.headCommittedAt > pr.createdAt ? pr.headCommittedAt : pr.createdAt;
  const seen: PullRequestSeen = {
    draft: pr.isDraft, conflicting: pr.conflicting, checks: pr.checks ?? 'none', openedAt: pr.createdAt, pushedAt, ...(pr.base ? { base: pr.base } : {}),
  };
  const now = (ctx.clock?.now() ?? new Date()).getTime();
  // Whatever its job's origin (issue #805): the trust decision was made when the job ran, before its pull request.
  if (pr.state !== 'open' || !ctx.yoloMode?.(repo) || !readyToMerge(seen, now)) return { seen };
  try {
    await ctx.api.merge(repo, numberOf(url));
    return { ended: 'merged' };
  } catch (err) {
    if (err instanceof GitHubApiError && !err.permanent) throw err;
    return { seen: { ...seen, mergeError: (err as Error).message } };
  }
}

/**
 * Whether the merge of pull request `url` closed the issue (issue #721): the issue is closed as completed, or the pull
 * request's body closes it with a closing keyword and is no part.
 */
async function closedByMerge(api: GitHubApi, repo: string, number: number, url: string): Promise<boolean> {
  if (isClosedAsCompleted(await api.getIssue(repo, number), await api.closingPullRequest(repo, number))) return true;
  const pr = (await api.referencingPullRequests(repo, number)).find((p) => p.url === url);
  return pr !== undefined && !isPartOf(pr, repo, number) && closesByKeyword(pr.body, repo, number);
}

/** What the hopper says on the issue it closes after its own merge (issue #677): neutral, the pull request's link only. */
export const closedAfterMergeComment = (url: string): string =>
  `Closed after the merge of ${url}. The pull request had no closing keyword for this issue.`;

/**
 * After the hopper's own merge of pull request `url` that did not close the issue (issue #677): a part ("Part of #N") stays
 * a part, and so does another issue's work that only mentions this one (issue #786); else the hopper closes the issue as
 * completed and comments with its link. Whether it closed the issue.
 */
async function closeAfterMerge(api: GitHubApi, repo: string, number: number, url: string): Promise<boolean> {
  const pr = (await api.referencingPullRequests(repo, number)).find((p) => p.url === url);
  if (pr && (isPartOf(pr, repo, number) || worksOnAnotherIssue(pr.body, repo, number))) return false;
  // Closed first: a sync after a failed comment finds it closed as completed, the item done.
  await api.closeAsCompleted(repo, number);
  await api.postComment(repo, number, closedAfterMergeComment(url));
  return true;
}

/**
 * A merge recorded as the whole item before issue #721, checked once: closed by it, it is marked checked; else it was a
 * part — `hopper:done` comes off, so the issue is offered again and its next part runs.
 */
async function recheckMerge(api: GitHubApi, repo: string, number: number, s: Followed & Record<string, unknown>): Promise<FollowUp> {
  const url = s.pullRequest ?? '';
  if (!s.pullRequest || await closedByMerge(api, repo, number, s.pullRequest)) {
    return { outcome: 'checked', pullRequest: url, part: false, state: { ...s, mergeChecked: true } };
  }
  await api.removeLabels(repo, number, [LABEL_DONE]);
  return { outcome: 'merged', pullRequest: url, part: true, state: { ...s, part: true } };
}

const isClosedAsNotPlanned = async (api: GitHubApi, repo: string, number: number): Promise<boolean> => {
  const issue = await api.getIssue(repo, number);
  return issue.state === 'closed' && issue.stateReason === 'not_planned';
};

/** The item closed as not planned upstream (issue #428): the follow ends abandoned; the waiting labels come off. */
async function abandon(api: GitHubApi, repo: string, number: number, s: Followed & Record<string, unknown>, url: string | undefined): Promise<FollowUp> {
  await api.removeLabels(repo, number, [LABEL_PR_READY, LABEL_PARTLY_DONE, LABEL_FAILED]);
  const pullRequest = url ?? s.pullRequest ?? '';
  return { outcome: 'abandoned', pullRequest, part: s.part === true, state: { ...s, ...(pullRequest ? { pullRequest } : {}), follow: 'abandoned' } };
}

/** Followed after its end; with `act`, a person's Merge now or Close PR on its open pull request (issue #677). */
export async function followPullRequest(ctx: FollowContext, job: Job, act?: PullRequestAct): Promise<FollowUp | undefined> {
  let s = (job.sourceState?.source ?? {}) as Followed & Record<string, unknown>;
  const { repo, number } = job.source ?? {};
  if (!repo || !number) return undefined;
  try {
    if (act && s.follow !== 'open') throw new SourceError('its pull request is not open', true);
    if (rechecksMerge(job)) return await recheckMerge(ctx.api, repo, number, s);
    if (s.follow !== 'open') return undefined;
    if (!s.pullRequest) {
      const found = await openPullRequestOf(ctx.api, repo, number);
      if (found) s = { ...s, pullRequest: found.url, ...(found.part ? { part: true } : {}) };
    }
    let now = await stateOf(ctx.api, repo, number, s);
    if (!act && (!now || now.state === 'open') && await isClosedAsNotPlanned(ctx.api, repo, number)) return await abandon(ctx.api, repo, number, s, now?.url);
    if (!now && act) throw new SourceError('no pull request is found for it yet', true);
    if (!now) return undefined;
    const part = s.part === true;
    let byHopper = false;
    let mergedHere = false;
    if (now.state === 'open') {
      const w = await waiting(ctx, job, now.url, s.seen, act);
      if ('seen' in w) {
        if (JSON.stringify(w.seen) === JSON.stringify(s.seen)) return undefined;
        return { outcome: 'open', pullRequest: now.url, part, state: { ...s, seen: w.seen } };
      }
      now = { state: w.ended, url: now.url };
      byHopper = !act;
      mergedHere = w.ended === 'merged';
    }
    // A merge that did not close the issue is a part (issue #721), whatever the report took it for — unless the hopper
    // merged it and it ships no part: then the hopper closes the issue (issue #677).
    const whole = now.state === 'merged' && !part && (await closedByMerge(ctx.api, repo, number, now.url)
      || (mergedHere && await closeAfterMerge(ctx.api, repo, number, now.url)));
    const shipsPart = part || (now.state === 'merged' && !whole);
    // A merged part that makes every declared part done (issue #729): the issue is done.
    const parts = now.state === 'merged' && shipsPart ? await partsOf(ctx.api, await ctx.api.getIssue(repo, number), now.url) : undefined;
    // A failed job's followed pull request (issue #786) ends its `hopper:failed` too.
    await ctx.api.removeLabels(repo, number, [LABEL_PR_READY, LABEL_PARTLY_DONE, LABEL_FAILED]);
    const add = now.state === 'closed' ? LABEL_PR_CLOSED : shipsPart && !allPartsDone(parts) ? undefined : LABEL_DONE;
    if (add) {
      await ensureLabels(ctx, repo);
      await ctx.api.addLabels(repo, number, [add]);
    }
    const after = { ...s, pullRequest: now.url, follow: now.state, ...(shipsPart ? { part: true } : {}), ...(whole ? { mergeChecked: true } : {}), ...(parts ? { parts } : {}) };
    return { outcome: now.state, pullRequest: now.url, part: shipsPart, ...(byHopper ? { byHopper } : {}), state: after };
  } catch (err) {
    if (err instanceof SourceError) throw err;
    // A person's act is answered GitHub's refusal as it is (issue #677); a sync asks again later.
    if (act && err instanceof GitHubApiError) throw new SourceError(err.message, err.permanent, err.status);
    throw new SourceError((err as Error).message, false);
  }
}
