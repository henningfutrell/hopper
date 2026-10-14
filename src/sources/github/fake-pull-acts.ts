// The in-memory fake's acts on an open pull request, for fake.ts: close it without a merge (issue #677), move its base
// (issue #1143), make it a draft (issue #724); and the comments on a pull request, by its URL (issue #1143).
import { GitHubApiError } from './api.ts';
import type { PostedComment, ReferencingPullRequest } from './api.ts';

type Pull = ReferencingPullRequest & { base?: string };
type Acts = 'closeWithoutMerge' | 'retarget' | 'toDraft';

export function fakePullActs(pulls: Pull[], enter: (method: Acts, args: unknown[]) => void, notFound: (what: string) => Error) {
  const comments = new Map<string, string[]>();
  const open = (repo: string, n: number): Pull => {
    const p = pulls.find((x) => x.url === `https://github.com/${repo}/pull/${n}`);
    if (!p) throw notFound(`${repo}/pull/${n}`);
    if (p.state !== 'open') throw new GitHubApiError(`Pull request is ${p.state} (HTTP 422): ${p.url}`, true, 422);
    return p;
  };
  return {
    /** A comment on pull request `n` of `repo`, as id `id`; undefined: `n` is no pull request. */
    comment(repo: string, n: number, body: string, id: number): PostedComment | undefined {
      const p = pulls.find((x) => x.url === `https://github.com/${repo}/pull/${n}`);
      if (!p) return undefined;
      comments.set(p.url, [...(comments.get(p.url) ?? []), body]);
      return { id, url: `${p.url}#issuecomment-${id}` };
    },
    api: {
      async closeWithoutMerge(repo: string, n: number): Promise<void> {
        enter('closeWithoutMerge', [repo, n]);
        const p = pulls.find((x) => x.url === `https://github.com/${repo}/pull/${n}`);
        if (!p) throw notFound(`${repo}/pull/${n}`);
        if (p.state === 'open') p.state = 'closed';
      },
      async retarget(repo: string, n: number, base: string): Promise<void> {
        enter('retarget', [repo, n, base]);
        open(repo, n).base = base;
      },
      async toDraft(repo: string, n: number): Promise<void> {
        enter('toDraft', [repo, n]);
        open(repo, n).isDraft = true;
      },
    },
    helpers: {
      pullRequestComments: (url: string): string[] => [...(comments.get(url) ?? [])],
    },
  };
}
