// The in-memory GitHub's git answer (issue #939, fake.ts): whether two pull requests conflict with each other, as a test
// set it. Never set: git cannot say, as where the hopper has no mirror.
import type { GitHubApi } from './api.ts';

export function fakeConflicts(enter: (method: 'conflictBetween', args: unknown[]) => void): Required<Pick<GitHubApi, 'conflictBetween'>> & {
  setConflictBetween(a: string, b: string, conflict: boolean): void;
} {
  const between = new Map<string, boolean>();
  const pair = (a: string, b: string): string => [a, b].sort().join(' ');
  return {
    async conflictBetween(repo, _base, a, b) {
      enter('conflictBetween', [repo, a, b]);
      return between.get(pair(`https://github.com/${repo}/pull/${a}`, `https://github.com/${repo}/pull/${b}`));
    },
    setConflictBetween(a, b, conflict) { between.set(pair(a, b), conflict); },
  };
}
