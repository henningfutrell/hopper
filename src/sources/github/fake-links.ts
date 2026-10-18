// The in-memory GitHub's reads of an item an issue's text names (fake.ts, issue #655 part 19): each repository's
// visibility (private unless a test sets it), and the pull requests a test adds with their author and whether their head
// is a fork. A read a test fails throws, once.
import type { LinkedItem, RepoVisibility } from '../../domain/linked-pulls.ts';
import type { GitHubApi } from './api.ts';
import type { Method } from './fake-types.ts';

export function fakeLinks(enter: (m: Method, args: unknown[]) => void) {
  const visibility = new Map<string, RepoVisibility>();
  const pulls = new Map<string, NonNullable<LinkedItem['pullRequest']>>();
  const failures = new Map<string, Error>();
  let number = 5000;
  const api: Pick<GitHubApi, 'linkedItem'> = {
    async linkedItem(repo, n) {
      enter('linkedItem', [repo, n]);
      const err = failures.get(`${repo}#${n}`);
      if (err) { failures.delete(`${repo}#${n}`); throw err; }
      const pr = pulls.get(`${repo}#${n}`);
      return { visibility: visibility.get(repo) ?? 'private', ...(pr ? { pullRequest: { ...pr } } : {}) };
    },
  };
  return {
    api,
    helpers: {
      setVisibility(repo: string, v: RepoVisibility) { visibility.set(repo, v); },
      addPullRequestBy(repo: string, author: string, o: { fork?: boolean } = {}) {
        const n = ++number;
        const url = `https://github.com/${repo}/pull/${n}`;
        pulls.set(`${repo}#${n}`, { url, author, fork: o.fork ?? false });
        return { number: n, url };
      },
      failLinkedRead(repo: string, n: number, error: Error) { failures.set(`${repo}#${n}`, error); },
    },
  };
}
