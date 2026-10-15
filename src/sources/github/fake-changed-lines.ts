// The in-memory GitHub's changed lines (issue #1076, fake.ts): the lines a pull request changes in the files asked for, as
// the hopper's mirror would say, as a test set them when it opened the pull request (`diff`). Never set: git cannot say.
import type { ChangedLines } from '../../domain/change-kinds.ts';
import type { GitHubApi } from './api.ts';

export function fakeChangedLines(enter: (method: 'changedLines', args: unknown[]) => void, diffOf: (url: string) => ChangedLines | undefined): Required<Pick<GitHubApi, 'changedLines'>> {
  return {
    async changedLines(repo, pr, paths) {
      enter('changedLines', [repo, pr.number, paths]);
      const diff = diffOf(`https://github.com/${repo}/pull/${pr.number}`);
      return diff && Object.fromEntries(paths.flatMap((f) => (diff[f] ? [[f, diff[f]]] : [])));
    },
  };
}
