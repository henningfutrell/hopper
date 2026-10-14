// Git answers (issue #858 part 2, design.md "Git efficiency"): whether an open pull request has merge conflicts, as the
// hopper's mirror says (`git merge-tree`), in place of GitHub's `mergeable`, for every read of the port that tells
// pull requests: the done-check, PR tending and the Pull requests list all read through them. GitHub's answer stays
// where git cannot say (no mirror, outside a pass, a head that moved since the pass's fetch), and for a pull request
// that is not open. Whether two open pull requests conflict with each other (`conflictBetween`, issue #939) is git's only,
// and so is the base merge (`baseMerge`, issue #967): the base branch merged into a pull request's head and pushed; and
// the tip of a base branch (`baseTip`, issue #1143 part 3), which tells a failed rebase tend its base moved.
// One read by its number — the follow's — also carries what it changes (issue #935 part 2): its commits and files, git's only.
// The port's other methods are the adapter's own.
import type { GitMirrors } from '../../git-mirror/mirrors.ts';
import type { BaseMerge, Job } from '../../domain/types.ts';
import type { GitHubApi, OpenPullRequest } from './api.ts';

const numberOf = (url: string): number => Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);
const PULL_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/;

/** `api` with each open pull request's conflicts from `mirrors`; `api` itself when it says nowhere git fetches. */
export function gitAnswers(api: GitHubApi, mirrors: GitMirrors | undefined): GitHubApi {
  const remote = api.gitRemote?.bind(api);
  if (!mirrors || !remote) return api;

  const answered = async <P extends OpenPullRequest & { state?: string }>(pr: P): Promise<P> => {
    const at = PULL_URL.exec(pr.url);
    if (!at || !pr.headOid || !pr.base || (pr.state !== undefined && pr.state !== 'open')) return pr;
    const repo = at[1]!;
    const said = await mirrors.mergeability(repo, () => remote(repo), { number: Number(at[2]), base: pr.base, headOid: pr.headOid });
    return said ? { ...pr, conflicting: said === 'conflicting' } : pr;
  };
  const each = <P extends OpenPullRequest>(prs: P[]): Promise<P[]> => Promise.all(prs.map(answered));

  const out: Partial<GitHubApi> = {
    openClosingPullRequests: async (repo, number) => each(await api.openClosingPullRequests(repo, number)),
    referencingPullRequests: async (repo, number) => each(await api.referencingPullRequests(repo, number)),
    pullRequest: async (repo, number) => {
      const pr = await api.pullRequest(repo, number);
      if (!pr) return pr;
      const [said, changes] = await Promise.all([answered(pr), pr.state === 'open' && pr.headOid && pr.base
        ? mirrors.changes(repo, () => remote(repo), { number, base: pr.base, headOid: pr.headOid }) : undefined]);
      return changes ? { ...said, ...changes } : said;
    },
    openPullRequests: async (repo) => each(await api.openPullRequests(repo)),
    conflictBetween: (repo, base, a, b) => mirrors.conflictBetween(repo, () => remote(repo), base, a, b),
    baseMerge: (repo, pr) => mirrors.baseMerge(repo, () => remote(repo), pr),
    baseTip: (repo, base) => mirrors.baseTip(repo, () => remote(repo), base),
  };
  return Object.assign(Object.create(api) as GitHubApi, out);
}

/** `JobSource.conflictBetween` (issue #939) over `api`'s git answer, the pull requests by URL; undefined where git cannot say. */
export const conflictBetweenOf = (api: GitHubApi) => async (repo: string, base: string, a: string, b: string): Promise<boolean | undefined> =>
  api.conflictBetween?.(repo, base, numberOf(a), numberOf(b));

/**
 * `JobSource.baseMerge` (issue #967) over `api`'s git answer: the job's followed pull request, its base and head branch as
 * its follow last saw them; undefined where git cannot, or the follow saw no branch.
 */
export const baseMergeOf = (api: GitHubApi) => async (job: Job): Promise<BaseMerge | undefined> => {
  const s = job.sourceState?.source as { pullRequest?: string; seen?: { base?: string; headRef?: string } } | undefined;
  const at = s?.pullRequest ? PULL_URL.exec(s.pullRequest) : null;
  if (!api.baseMerge || !at || !s?.seen?.base || !s.seen.headRef) return undefined;
  return api.baseMerge(at[1]!, { number: Number(at[2]), base: s.seen.base, headRef: s.seen.headRef });
};

/**
 * `JobSource.baseTip` (issue #1143 part 3) over `api`'s git answer: the tip of the base branch of the job's pull request,
 * as its follow last saw that base; undefined where git cannot say, or the follow saw no base.
 */
export const baseTipOf = (api: GitHubApi) => async (job: Job): Promise<string | undefined> => {
  const s = job.sourceState?.source as { pullRequest?: string; seen?: { base?: string } } | undefined;
  const at = s?.pullRequest ? PULL_URL.exec(s.pullRequest) : null;
  if (!api.baseTip || !at || !s?.seen?.base) return undefined;
  return api.baseTip(at[1]!, s.seen.base);
};
