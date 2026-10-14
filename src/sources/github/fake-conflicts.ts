// The in-memory GitHub's git answers (issue #939, fake.ts): whether two pull requests conflict with each other, as a test
// set it; and the base merge (issue #967): what the hopper's mirror does for a pull request, as a test set it — pushed,
// which is a push to the pull request (`pushed`: a new head commit, no merge conflicts, its checks run again), or the
// conflicts it does not resolve. Never set: git cannot say, as
// where the hopper has no mirror. Two pull requests set to conflict: the merge of one gives the other merge conflicts with
// its base (issue #967, `conflictsWith`), as the mirror would see the moved base. And the tip of a base branch (issue #1143
// part 3), as a test set it; never set: git cannot say.
import type { BaseMerge } from '../../domain/pull-requests.ts';
import type { GitHubApi } from './api.ts';

/** What a test sets the base merge of a pull request to do (issue #967). */
export type FakeBaseMerge = { resolved: string[] } | { conflicts: string[] };

type FakeConflictMethods = Required<Pick<GitHubApi, 'conflictBetween' | 'baseMerge' | 'baseTip'>> & {
  setBaseTip(repo: string, base: string, tip: string | undefined): void;
  setConflictBetween(a: string, b: string, conflict: boolean): void;
  setBaseMerge(url: string, answer: FakeBaseMerge | undefined): void;
};

/** `methods`: what the fake answers and does; `conflictsWith`: the pull requests set to conflict with `url`. */
export function fakeConflicts(enter: (method: 'conflictBetween' | 'baseMerge' | 'baseTip', args: unknown[]) => void, pushed: (url: string) => void): {
  methods: FakeConflictMethods; conflictsWith(url: string): string[];
} {
  const between = new Map<string, boolean>();
  const merges = new Map<string, FakeBaseMerge>();
  const tips = new Map<string, string>();
  const pair = (a: string, b: string): string => [a, b].sort().join(' ');
  let commits = 0;
  const methods: FakeConflictMethods = {
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
    async baseTip(repo, base) {
      enter('baseTip', [repo, base]);
      return tips.get(`${repo} ${base}`);
    },
    setBaseTip(repo, base, tip) { if (tip) tips.set(`${repo} ${base}`, tip); else tips.delete(`${repo} ${base}`); },
    setConflictBetween(a, b, conflict) { between.set(pair(a, b), conflict); },
    setBaseMerge(url, answer) { if (answer) merges.set(url, answer); else merges.delete(url); },
  };
  const conflictsWith = (url: string): string[] =>
    [...between].filter(([k, conflict]) => conflict && k.split(' ').includes(url)).map(([k]) => k.split(' ').find((u) => u !== url)!);
  return { methods, conflictsWith };
}
