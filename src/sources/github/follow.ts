// Following a done job's pull request after its end was reported (issue #579, design.md "Done is a pull request"). The
// report kept it in the job's source state (`pullRequest`, `follow: open`, `part` for a part). Merged — the issue
// closed as complete by it, or the pull request merged —: the item is done, `hopper:pr-ready` → `hopper:done`; a part's
// `hopper:partly-done` only comes off, so the issue is offered again and its next part runs. Closed without a merge:
// flagged, → `hopper:pr-closed`, which keeps the issue out until a person removes it. Still open (PR waiting, issue #637):
// what is seen of it — a draft, merge conflicts, its checks — is kept for the Pull requests list; and with yolo mode on for
// its repository, the hopper merges it once it is ready: not a draft, no merge conflicts, and its checks passed — or it
// has none, and none started within a grace window after its last push (issue #677; issue #652 had it wait for ever). A
// refused merge is kept on it (`mergeError`) and asked again next sync: it never fails the job. A pull request the
// report could not name is looked for again each sync, and named once found (issue #677). A throw is asked again on a
// later sync.

import { readyToMerge, type FollowUp, type Job, type PullRequestSeen } from '../../domain/types.ts';
import type { Clock } from '../../domain/ports.ts';
import { SourceError } from '../../domain/ports.ts';
import { GitHubApiError, type GitHubApi } from './api.ts';
import { isClosedAsCompleted, isPartOf, namesIssue } from './completion.ts';
import { LABEL_DONE, LABEL_PARTLY_DONE, LABEL_PR_CLOSED, LABEL_PR_READY } from './labels.ts';
import { ensureLabels, type ReportContext } from './report.ts';

interface Followed { pullRequest?: string; follow?: string; part?: boolean; seen?: PullRequestSeen }

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
  const mention = newest((await api.referencingPullRequests(repo, number)).filter((pr) => pr.state === 'open' && pr.repo.toLowerCase() === repo.toLowerCase()));
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

/** An open pull request: what is seen of it, and, yolo mode on and it ready, the hopper's merge. True: merged. */
async function waiting(ctx: FollowContext, repo: string, url: string, before: PullRequestSeen | undefined): Promise<{ merged: true } | { seen: PullRequestSeen }> {
  const pr = await ctx.api.pullRequest(repo, numberOf(url));
  if (!pr) return { seen: before ?? { draft: false, conflicting: false, checks: 'none' } };
  const pushedAt = pr.headCommittedAt && pr.headCommittedAt > pr.createdAt ? pr.headCommittedAt : pr.createdAt;
  const seen: PullRequestSeen = {
    draft: pr.isDraft, conflicting: pr.conflicting, checks: pr.checks ?? 'none', openedAt: pr.createdAt, pushedAt, ...(pr.base ? { base: pr.base } : {}),
  };
  const now = (ctx.clock?.now() ?? new Date()).getTime();
  if (pr.state !== 'open' || !ctx.yoloMode?.(repo) || !readyToMerge(seen, now)) return { seen };
  try {
    await ctx.api.merge(repo, numberOf(url));
    return { merged: true };
  } catch (err) {
    if (err instanceof GitHubApiError && !err.permanent) throw err;
    return { seen: { ...seen, mergeError: (err as Error).message } };
  }
}

export async function followPullRequest(ctx: FollowContext, job: Job): Promise<FollowUp | undefined> {
  let s = (job.sourceState?.source ?? {}) as Followed & Record<string, unknown>;
  const { repo, number } = job.source ?? {};
  if (s.follow !== 'open' || !repo || !number) return undefined;
  try {
    if (!s.pullRequest) {
      const found = await openPullRequestOf(ctx.api, repo, number);
      if (found) s = { ...s, pullRequest: found.url, ...(found.part ? { part: true } : {}) };
    }
    let now = await stateOf(ctx.api, repo, number, s);
    if (!now) return undefined;
    const part = s.part === true;
    let byHopper = false;
    if (now.state === 'open') {
      const w = await waiting(ctx, repo, now.url, s.seen);
      if ('seen' in w) {
        if (JSON.stringify(w.seen) === JSON.stringify(s.seen)) return undefined;
        return { outcome: 'open', pullRequest: now.url, part, state: { ...s, seen: w.seen } };
      }
      now = { state: 'merged', url: now.url };
      byHopper = true;
    }
    await ctx.api.removeLabels(repo, number, [LABEL_PR_READY, LABEL_PARTLY_DONE]);
    const add = now.state === 'closed' ? LABEL_PR_CLOSED : part ? undefined : LABEL_DONE;
    if (add) {
      await ensureLabels(ctx, repo);
      await ctx.api.addLabels(repo, number, [add]);
    }
    return { outcome: now.state, pullRequest: now.url, part, ...(byHopper ? { byHopper } : {}), state: { ...s, pullRequest: now.url, follow: now.state } };
  } catch (err) {
    throw err instanceof SourceError ? err : new SourceError((err as Error).message, false);
  }
}
