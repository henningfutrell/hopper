// The lines a pull request changes (issue #1076, design.md "Change kinds"), from `git diff -U0` of the hopper's mirror
// (`mirrors.ts` `changedLines`): each added or removed line of each file asked for, without its sign; a binary file has
// none. Split from mirrors.ts for its line budget.
import type { ChangedLines } from '../domain/change-kinds.ts';

/** At most this many changed lines are read of one pull request (issue #1076). */
export const CHANGED_LINES = 20_000;

/**
 * `git diff -U0` output as the changed lines of each file in `paths`; undefined: a file it cannot name among them, or more
 * than `CHANGED_LINES` lines.
 */
export function parseDiff(out: string, paths: string[]): ChangedLines | undefined {
  const asked = new Set(paths);
  const files: ChangedLines = {};
  let file: string | undefined;
  let minus: string | undefined;
  let hunk = false;
  let count = 0;
  for (const l of out.split('\n')) {
    if (l.startsWith('diff --git ')) { file = undefined; minus = undefined; hunk = false; continue; }
    if (!hunk) {
      if (l.startsWith('--- ')) minus = l.slice(4);
      else if (l.startsWith('+++ ')) {
        const plus = l.slice(4);
        const name = plus === '/dev/null' ? minus?.replace(/^a\//, '') : plus.replace(/^b\//, '');
        if (name === undefined || !asked.has(name)) return undefined;
        file = name;
        files[file] = [];
      } else if (l.startsWith('Binary files ')) {
        const name = paths.find((p) => l.includes(` b/${p} differ`) || l.includes(` a/${p} and /dev/null differ`));
        if (name === undefined) return undefined;
        files[name] = 'binary';
      } else if (l.startsWith('@@')) {
        if (file === undefined) return undefined;
        hunk = true;
      }
      continue;
    }
    if (l.startsWith('@@')) continue;
    if (l.startsWith('+') || l.startsWith('-')) {
      if (++count > CHANGED_LINES) return undefined;
      (files[file!] as string[]).push(l.slice(1));
    }
  }
  return files;
}
