// The fake GitHub's repository event feeds (issue #967, `GitHubApi.repoEvents`): each pull request opened, merged or closed,
// and each push, is an event of its repository, newest first, as GitHub lists them. A test adds any other kind itself.
import type { RepoEvent } from './api.ts';
import type { FakeGitHub } from './fake-types.ts';

/** How many events GitHub's first page of a feed holds, as the adapters ask for it. */
const PAGE = 30;

/** `enter`: the fake's own call record, which a `failNext` throws from. */
export function fakeFeed(enter: (method: 'repoEvents', args: unknown[]) => void) {
  const feeds = new Map<string, RepoEvent[]>();
  let id = 5000;
  let tick = 0;
  /** An event of `type` in `repo`'s feed, now. */
  const record = (repo: string, type: string): void => {
    const k = repo.toLowerCase();
    const at = new Date(Date.UTC(2026, 9, 2, 12, 0, tick++)).toISOString();
    feeds.set(k, [{ id: String(++id), type, createdAt: at }, ...(feeds.get(k) ?? [])]);
  };
  return {
    record,
    /** What the fake answers and does with it. */
    methods: {
      async repoEvents(repo: string): Promise<RepoEvent[]> {
        enter('repoEvents', [repo]);
        return (feeds.get(repo.toLowerCase()) ?? []).slice(0, PAGE).map((e) => ({ ...e }));
      },
      pushTo(repo: string, _ref: string): void { record(repo, 'PushEvent'); },
      feedEvent(repo: string, type: string): void { record(repo, type); },
    } satisfies Pick<FakeGitHub, 'repoEvents' | 'pushTo' | 'feedEvent'>,
  };
}
