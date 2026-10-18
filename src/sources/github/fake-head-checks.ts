// The in-memory GitHub's REST read of a commit's checks (issue #1244, fake.ts): what a test set for a pull request, by its
// head branch; never set: refused as the rollup was (403 to both reads), so its checks stay unknown.
import type { GitHubApi, HeadChecks } from './api.ts';
import type { CheckFact } from '../../domain/conditional-skills.ts';

type FakeHeadCheckMethods = Required<Pick<GitHubApi, 'headChecks' | 'checkRuns'>> & {
  /** What the REST read of pull request `url`'s head commit answers. */
  setHeadChecks(url: string, answer: HeadChecks): void;
  /** Each check of pull request `url`'s head commit, with its output text (issue #1924); never set: none. */
  setCheckRuns(url: string, runs: CheckFact[]): void;
};

/** `urlOf`: the pull request of `repo` whose head branch is `ref`. */
export function fakeHeadChecks(enter: (method: 'headChecks' | 'checkRuns', args: unknown[]) => void, urlOf: (repo: string, ref: string) => string | undefined): FakeHeadCheckMethods {
  const answers = new Map<string, HeadChecks>();
  const runs = new Map<string, CheckFact[]>();
  return {
    async headChecks(repo, ref) {
      enter('headChecks', [repo, ref]);
      const url = urlOf(repo, ref);
      return (url && answers.get(url)) || { unreadable: ['checks', 'statuses'] };
    },
    setHeadChecks(url, answer) { answers.set(url, answer); },
    async checkRuns(repo, ref) {
      enter('checkRuns', [repo, ref]);
      const url = urlOf(repo, ref);
      return (url ? runs.get(url) : undefined)?.map((r) => ({ ...r })) ?? [];
    },
    setCheckRuns(url, list) { runs.set(url, list); },
  };
}
