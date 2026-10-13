// The in-memory fake's batched pull request reads (issue #985, the in-motion cycle), for fake.ts: each followed pull request
// and its issue as GitHub would tell them, and the open pull requests of many repositories. One the fake does not know is an
// error of its own, never a throw.
import type { BranchPullRequest, GitHubIssue, OpenPullRequestsIn, PullRequestRef, PullRequestStates, ReferencingPullRequest } from './api.ts';
import { pullKey } from './api.ts';

type Pull = ReferencingPullRequest & { headRef: string; base?: string };

export function fakePulls(pulls: Pull[], issues: Map<string, GitHubIssue>, enter: (method: 'pullRequestStates' | 'openPullRequestsIn', args: unknown[]) => void) {
  return {
    async pullRequestStates(refs: PullRequestRef[]): Promise<PullRequestStates> {
      enter('pullRequestStates', [refs]);
      const out: PullRequestStates = { pulls: new Map(), errors: new Map() };
      for (const r of refs) {
        const p = pulls.find((x) => x.url === `https://github.com/${r.repo}/pull/${r.pullRequest}`);
        if (!p) { out.errors.set(pullKey(r.repo, r.pullRequest), `Could not resolve to a PullRequest with the number of ${r.pullRequest}.`); continue; }
        const i = issues.get(`${r.repo}#${r.issue}`);
        out.pulls.set(pullKey(r.repo, r.pullRequest), {
          state: p.state, isDraft: p.isDraft, mergeable: p.conflicting ? 'CONFLICTING' : 'MERGEABLE', createdAt: p.createdAt, body: p.body,
          headRef: p.headRef, ...(p.base ? { base: p.base } : {}), ...(p.headCommittedAt ? { headCommittedAt: p.headCommittedAt } : {}), ...(p.checks ? { checks: p.checks } : {}),
          ...(i ? { issue: { state: i.state, ...(i.stateReason ? { stateReason: i.stateReason } : {}), updatedAt: i.updatedAt } } : {}),
        });
      }
      return out;
    },
    async openPullRequestsIn(repos: string[]): Promise<OpenPullRequestsIn> {
      enter('openPullRequestsIn', [repos]);
      const out: OpenPullRequestsIn = { repos: new Map(), repoErrors: new Map() };
      for (const repo of repos) {
        out.repos.set(repo, pulls.filter((p) => p.repo === repo && p.state === 'open').reverse()
          .map((p): BranchPullRequest => ({ url: p.url, createdAt: p.createdAt, isDraft: p.isDraft, conflicting: p.conflicting, headRef: p.headRef, body: p.body })));
      }
      return out;
    },
  };
}
