// Following a done job's pull request after its end was reported (issue #579, design.md "Done is a pull request"). The
// report kept it in the job's source state (`pullRequest`, `follow: open`, `part` for a part). Merged — the issue
// closed as complete by it, or the pull request merged —: the item is done, `hopper:pr-ready` → `hopper:done`; a part's
// `hopper:partly-done` only comes off, so the issue is offered again and its next part runs. Closed without a merge:
// flagged, → `hopper:pr-closed`, which keeps the issue out until a person removes it. Still open (PR waiting, issue #637):
// what is seen of it — a draft, merge conflicts, its checks — is kept for the Pull requests list; and with yolo mode on for
// its repository, the hopper merges it once it is ready: not a draft, no merge conflicts, its checks passed or none. A
// refused merge is kept on it (`mergeError`) and asked again next sync: it never fails the job. A pull request the
// report could not name is followed only to its merge. A throw is asked again on a later sync.

import type { FollowUp, Job, PullRequestSeen } from '../../domain/types.ts';
import { SourceError } from '../../domain/ports.ts';
import { GitHubApiError, type GitHubApi } from './api.ts';
import { isClosedAsCompleted, isPartOf } from './completion.ts';
import { LABEL_DONE, LABEL_PARTLY_DONE, LABEL_PR_CLOSED, LABEL_PR_READY } from './labels.ts';
import { ensureLabels, type ReportContext } from './report.ts';

interface Followed { pullRequest?: string; follow?: string; part?: boolean; seen?: PullRequestSeen }

/** What following a pull request needs beyond the report's: whether the hopper may merge in a repository (yolo mode). */
export interface FollowContext extends ReportContext { yoloMode?: (repo: string) => boolean }

type PullState = 'open' | 'merged' | 'closed';

const numberOf = (url: string): number => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);

/** Where the pull request is now; undefined: it cannot be told yet (the report named none, and nothing merged). */
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

/** Ready for the hopper's merge: not a draft, no merge conflicts, its checks passed or it has none. */
const mergeable = (seen: PullRequestSeen): boolean => !seen.draft && !seen.conflicting && (seen.checks === 'passing' || seen.checks === 'none');

/** An open pull request: what is seen of it, and, yolo mode on and it ready, the hopper's merge. True: merged. */
async function waiting(ctx: FollowContext, repo: string, url: string, before: PullRequestSeen | undefined): Promise<{ merged: true } | { seen: PullRequestSeen }> {
  const pr = await ctx.api.pullRequest(repo, numberOf(url));
  if (!pr) return { seen: before ?? { draft: false, conflicting: false, checks: 'none' } };
  const seen: PullRequestSeen = { draft: pr.isDraft, conflicting: pr.conflicting, checks: pr.checks ?? 'none', openedAt: pr.createdAt };
  if (pr.state !== 'open' || !ctx.yoloMode?.(repo) || !mergeable(seen)) return { seen };
  try {
    await ctx.api.merge(repo, numberOf(url));
    return { merged: true };
  } catch (err) {
    if (err instanceof GitHubApiError && !err.permanent) throw err;
    return { seen: { ...seen, mergeError: (err as Error).message } };
  }
}

export async function followPullRequest(ctx: FollowContext, job: Job): Promise<FollowUp | undefined> {
  const s = (job.sourceState?.source ?? {}) as Followed & Record<string, unknown>;
  const { repo, number } = job.source ?? {};
  if (s.follow !== 'open' || !repo || !number) return undefined;
  try {
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
