// The in-memory GitHub's git answers (issue #939, fake.ts): whether two pull requests conflict with each other, as a test
// set it; and the base merge (issue #967): what the hopper's mirror does for a pull request, as a test set it — pushed,
// which is a push to the pull request (`pushed`), or the conflicts it does not resolve. Never set: git cannot say, as
// where the hopper has no mirror.
import type { BaseMerge } from '../../domain/pull-requests.ts';
import type { GitHubApi } from './api.ts';

/** What a test sets the base merge of a pull request to do (issue #967). */
export type FakeBaseMerge = { resolved: string[] } | { conflicts: string[] };

export function fakeConflicts(enter: (method: 'conflictBetween' | 'baseMerge', args: unknown[]) => void, pushed: (url: string) => void): Required<Pick<GitHubApi, 'conflictBetween' | 'baseMerge'>> & {
  setConflictBetween(a: string, b: string, conflict: boolean): void;
  setBaseMerge(url: string, answer: FakeBaseMerge | undefined): void;
} {
  const between = new Map<string, boolean>();
  const merges = new Map<string, FakeBaseMerge>();
  const pair = (a: string, b: string): string => [a, b].sort().join(' ');
  let commits = 0;
  return {
    async conflictBetween(repo, _base, a, b) {
      enter('conflictBetween', [repo, a, b]);
      return between.get(pair(`https://github.com/${repo}/pull/${a}`, `https://github.com/${repo}/pull/${b}`));
    },
    async baseMerge(repo, pr): Promise<BaseMerge | undefined> {
      enter('baseMerge', [repo, pr]);
      const url = `https://github.com/${repo}/pull/${pr.number}`;
      const answer = merges.get(url);
      if (!answer) return undefined;
      if ('conflicts' in answer) return { outcome: 'conflicts', files: answer.conflicts };
      pushed(url);
      return { outcome: 'pushed', commit: (++commits).toString(16).padStart(40, '0'), resolved: answer.resolved };
    },
    setConflictBetween(a, b, conflict) { between.set(pair(a, b), conflict); },
    setBaseMerge(url, answer) { if (answer) merges.set(url, answer); else merges.delete(url); },
  };
}
