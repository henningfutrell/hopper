// A direct job's pull request (issue #1068, design.md "Direct jobs"): followed as a job of an issue's is (follow.ts), with
// no issue to read, label or close.
import { SourceError } from '../../domain/ports.ts';
import { pullRequestRepo, type FollowUp, type Job, type PullRequestAct, type PullRequestSeen } from '../../domain/types.ts';
import { GitHubApiError } from './api.ts';
import type { PullRequestContext } from './follow-context.ts';
import { numberOf, waiting } from './follow.ts';

interface Followed { pullRequest?: string; follow?: string; seen?: PullRequestSeen }

/**
 * Follow a direct job's own pull request (issue #1068, design.md "Direct jobs"): the one its report kept (`pullRequest`,
 * `follow: open`). A direct job has no issue, so nothing here reads, labels or closes one: the pull request alone says
 * where it is. Open: what is seen of it, moved to the landing branch or closed as superseded, and merged by the hopper once
 * ready under its repository's gate (yolo mode), as for a job of an issue. Merged or closed without a merge: it ends, and
 * the merge closes nothing. A throw is asked again on a later sync.
 */
export async function followDirectPullRequest(ctx: PullRequestContext, job: Job, act?: PullRequestAct): Promise<FollowUp | undefined> {
  const s = (job.sourceState?.source ?? {}) as Followed & Record<string, unknown>;
  const url = s.pullRequest;
  try {
    if (act && (s.follow !== 'open' || !url)) throw new SourceError('its pull request is not open', true);
    if (s.follow !== 'open' || !url || !job.source?.repo) return undefined;
    const pr = act ? undefined : await ctx.api.pullRequest(pullRequestRepo(url, job.source.repo), numberOf(url));
    // Merged or closed on GitHub by someone else: it ended, and nothing more is read.
    if (pr && pr.state !== 'open') return { outcome: pr.state, pullRequest: url, part: false, state: { ...s, follow: pr.state } };
    const w = await waiting(ctx, job, url, s.seen, act);
    if (!('ended' in w)) {
      if (JSON.stringify(w.seen) === JSON.stringify(s.seen) && !w.retargeted) return undefined;
      return { outcome: 'open', pullRequest: url, part: false, state: { ...s, seen: w.seen }, ...(w.retargeted ? { retargeted: w.retargeted } : {}) };
    }
    return {
      outcome: w.ended, pullRequest: url, part: false, ...(!act && !w.superseded ? { byHopper: true } : {}), ...(w.superseded ? { superseded: w.superseded } : {}),
      state: { ...s, ...(w.seen?.change ? { seen: w.seen } : {}), follow: w.ended },
    };
  } catch (err) {
    if (err instanceof SourceError) throw err;
    if (act && err instanceof GitHubApiError) throw new SourceError(err.message, err.permanent, err.status);
    throw new SourceError((err as Error).message, false);
  }
}
