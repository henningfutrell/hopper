// The in-memory fake's repository listings (issue #985), for fake.ts: the open issues of each repository with one of the
// labels; a repository `failRepo` names is one GitHub does not answer for, until `failRepo` names it with no message.
import type { ListedItem, RepoListing } from '../../domain/github-listing.ts';
import type { GitHubIssue } from './api.ts';

const listed = (i: GitHubIssue): ListedItem => ({
  repo: i.repo, number: i.number, kind: 'issue', url: i.url, title: i.title, author: i.author, labels: [...i.labels], assignees: [...i.assignees], updatedAt: i.updatedAt,
});

export function fakeListing(issues: Map<string, GitHubIssue>, enter: (method: 'listRepos', args: unknown[]) => void) {
  const failing = new Map<string, string>();
  return {
    async listRepos(repos: string[], labels: string[]): Promise<RepoListing> {
      enter('listRepos', [repos, labels]);
      const out: RepoListing = { repos: new Map(), repoErrors: new Map() };
      for (const repo of repos) {
        const error = failing.get(repo);
        if (error !== undefined) { out.repoErrors.set(repo, error); continue; }
        out.repos.set(repo, [...issues.values()].filter((i) => i.repo === repo && i.state === 'open' && i.labels.some((l) => labels.includes(l))).map(listed));
      }
      return out;
    },
    failRepo(repo: string, message: string | undefined) { if (message === undefined) failing.delete(repo); else failing.set(repo, message); },
  };
}
