// Git answers (issue #858 part 2, design.md "Git efficiency"): whether an open pull request has merge conflicts, as the
// hopper's mirror says (`git merge-tree`), in place of GitHub's `mergeable`, for every read of the port that tells
// pull requests: the done-check, PR tending and the Pull requests list all read through them. GitHub's answer stays
// where git cannot say (no mirror, outside a pass, a head that moved since the pass's fetch), and for a pull request
// that is not open. The port's other methods are the adapter's own.
import type { GitMirrors } from '../../git-mirror/mirrors.ts';
import type { GitHubApi, OpenPullRequest } from './api.ts';

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
    pullRequest: async (repo, number) => { const pr = await api.pullRequest(repo, number); return pr && answered(pr); },
    openPullRequests: async (repo) => each(await api.openPullRequests(repo)),
  };
  return Object.assign(Object.create(api) as GitHubApi, out);
}
