// Companion pull requests (issue #1143 reopened, design.md "Companion pull requests"), GitHub's half: each is read by its
// number — its state, its merge conflicts with its base (the hopper's mirror's answer where it has one, else GitHub's), and
// its base and head branch. One open and ready is merged as a followed pull request is (`mergeWhenReady`, issue #2752 part
// 3): under its own repository's yolo mode and change kinds, through the merge gate, its holder's done criteria met. One
// GitHub does not know, or whose read or merge throws, is logged and left out: asked again at the next round. A merge
// GitHub refuses is logged, and the companion is kept open. One asked with `merge: false` (a waiting job's) is only read.
// A done item's companion rebase issue (`fileCompanionRebase`) is filed on the item's repository, with the job sources'
// label and assigned to the connected account; with no account connected, none is filed.
import type { CompanionRead } from '../../domain/companion-pull-requests.ts';
import { SourceError } from '../../domain/ports.ts';
import type { Job } from '../../domain/types.ts';
import type { GitHubApi } from './api.ts';
import type { PullRequestContext } from './follow-context.ts';
import { mergeWhenReady, seenOf } from './follow.ts';

export async function readCompanions(ctx: PullRequestContext, pulls: { repo: string; number: number; job: Job; merge?: false }[]): Promise<CompanionRead[]> {
  const read: CompanionRead[] = [];
  for (const { repo, number, job, merge } of pulls) {
    try {
      const pr = await ctx.api.pullRequest(repo, number);
      if (!pr) continue;
      const branches = { ...(pr.base ? { base: pr.base } : {}), ...(pr.headRef ? { headRef: pr.headRef } : {}), ...(pr.headOid ? { head: pr.headOid } : {}) };
      if (pr.state === 'open' && !pr.conflicting && merge !== false) {
        const m = await mergeWhenReady(ctx, job, repo, pr.url, pr, seenOf(pr, undefined), undefined);
        if ('ended' in m) {
          read.push({ url: pr.url, state: 'merged', conflicting: false, ...branches, byHopper: true });
          continue;
        }
        if (m.seen.mergeError) console.warn(`hopper: the companion pull request ${repo}#${number} was not merged: ${m.seen.mergeError}`);
      }
      read.push({ url: pr.url, state: pr.state, conflicting: pr.state === 'open' && pr.conflicting, ...branches });
    } catch (e) {
      console.warn(`hopper: the companion pull request ${repo}#${number} was not read, asked again at the next round: ${(e as Error).message}`);
    }
  }
  return read;
}

export async function fileCompanionRebase(api: GitHubApi, job: Job, text: { title: string; body: string }, label: string, assignee: string | undefined): Promise<{ number: number; url: string }> {
  if (!api.fileIssue || !job.source?.repo) throw new SourceError('this source cannot file an issue', true);
  if (assignee === undefined) throw new SourceError('no GitHub account is connected', false);
  return api.fileIssue(job.source.repo, { ...text, labels: [label], assignees: [assignee] });
}
