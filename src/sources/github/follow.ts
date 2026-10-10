// Following a done job's pull request after its end was reported (issue #579, design.md "Done is a pull request"). The
// report kept it in the job's source state (`pullRequest`, `follow: open`, `part` for a part). Merged — the issue
// closed as complete by it, or the pull request merged —: the item is done, `hopper:pr-ready` → `hopper:done`; a part's
// `hopper:partly-done` only comes off, so the issue is offered again and its next part runs. Closed without a merge:
// flagged, → `hopper:pr-closed`, which keeps the issue out until a person removes it. Still open: nothing changes.
// A pull request the report could not name is followed only to its merge. A throw is asked again on a later sync.

import type { FollowUp, Job } from '../../domain/types.ts';
import { SourceError } from '../../domain/ports.ts';
import type { GitHubApi } from './api.ts';
import { isClosedAsCompleted, isPartOf } from './completion.ts';
import { LABEL_DONE, LABEL_PARTLY_DONE, LABEL_PR_CLOSED, LABEL_PR_READY } from './labels.ts';
import { ensureLabels, type ReportContext } from './report.ts';

interface Followed { pullRequest?: string; follow?: string; part?: boolean }

type PullState = 'open' | 'merged' | 'closed';

/** Where the pull request is now; undefined: it cannot be told yet (the report named none, and nothing merged). */
async function stateOf(api: GitHubApi, repo: string, number: number, s: Followed): Promise<{ state: PullState; url: string } | undefined> {
  if (!s.part) {
    const closer = await api.closingPullRequest(repo, number);
    if (isClosedAsCompleted(await api.getIssue(repo, number), closer)) return { state: 'merged', url: closer?.url ?? s.pullRequest ?? '' };
  }
  if (!s.pullRequest) return undefined;
  const mention = (await api.referencingPullRequests(repo, number)).find((pr) => pr.url === s.pullRequest);
  if (mention) return s.part && !isPartOf(mention, repo, number) ? undefined : { state: mention.state, url: mention.url };
  const open = (await api.openClosingPullRequests(repo, number)).some((pr) => pr.url === s.pullRequest);
  return { state: open ? 'open' : 'closed', url: s.pullRequest };
}

export async function followPullRequest(ctx: ReportContext, job: Job): Promise<FollowUp | undefined> {
  const s = (job.sourceState?.source ?? {}) as Followed & Record<string, unknown>;
  const { repo, number } = job.source ?? {};
  if (s.follow !== 'open' || !repo || !number) return undefined;
  try {
    const now = await stateOf(ctx.api, repo, number, s);
    if (!now || now.state === 'open') return undefined;
    const part = s.part === true;
    await ctx.api.removeLabels(repo, number, [LABEL_PR_READY, LABEL_PARTLY_DONE]);
    const add = now.state === 'closed' ? LABEL_PR_CLOSED : part ? undefined : LABEL_DONE;
    if (add) {
      await ensureLabels(ctx, repo);
      await ctx.api.addLabels(repo, number, [add]);
    }
    return { outcome: now.state, pullRequest: now.url, part, state: { ...s, pullRequest: now.url, follow: now.state } };
  } catch (err) {
    throw err instanceof SourceError ? err : new SourceError((err as Error).message, false);
  }
}
