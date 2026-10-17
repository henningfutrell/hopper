// One conflicted file of the base merge (issue #967, design.md "The base merge"), resolved by keeping both sides' added
// lines, the base branch's first. Each side is read with `git cat-file blob` into a scratch file of its own and the three
// files are merged by `git merge-file`: the container image's git (2.39) has no `merge-file --object-id` (git 2.43). It
// exited 129 with no merge printed, and a build that read that as a resolution emptied docs/design.md on main (issues
// #1218, #1624). Anything git cannot merge so, or a conflict that holds a line of the merge base, is not resolved.
import { rmSync, writeFileSync } from 'node:fs';
import type { GitRun } from './mirrors.ts';

type Run = (args: string[], env?: Record<string, string>) => ReturnType<GitRun>;

/** A resolved file, as a blob written to the mirror, with its lines as `git diff --numstat` counts them. */
export interface Blob { path: string; mode: string; oid: string; lines: number }

/** A conflict marker of `git merge-file --diff3` at `MARKER` characters: longer than any line a file is likely to hold. */
const MARKER = 40;

/**
 * Both sides' additions of a `git merge-file --diff3` result (issue #967), the base branch's (`theirs`) first; undefined
 * when a conflict holds a line of the merge base: one side changed or removed a line, which is a real conflict.
 */
export function keepBothAdditions(merged: string): string | undefined {
  const [open, mid, sep, close] = ['<', '|', '=', '>'].map((c) => c.repeat(MARKER));
  const out: string[] = [];
  let ours: string[] = [], base: string[] = [], theirs: string[] = [];
  let at: 'none' | 'ours' | 'base' | 'theirs' = 'none';
  for (const line of merged.split('\n')) {
    if (at === 'none' && line.startsWith(`${open!} `)) { at = 'ours'; ours = []; base = []; theirs = []; continue; }
    if (at === 'ours' && line.startsWith(`${mid!} `)) { at = 'base'; continue; }
    if (at === 'base' && line === sep) { at = 'theirs'; continue; }
    if (at === 'theirs' && line.startsWith(`${close!} `)) {
      if (base.length > 0) return undefined;
      out.push(...theirs, ...ours);
      at = 'none';
      continue;
    }
    (at === 'ours' ? ours : at === 'base' ? base : at === 'theirs' ? theirs : out).push(line);
  }
  return at === 'none' ? out.join('\n') : undefined;
}

/** A text's lines as `git diff --numstat` counts them: a last line with no newline counts too. */
export const lineCount = (text: string): number => text.split('\n').length - (text.endsWith('\n') || text === '' ? 1 : 0);

/**
 * `path` merged at `head`, `mergeBase` and `base` with both sides' additions kept, as a blob written to the mirror;
 * undefined: not resolved (not a plain file, not on all three sides, not UTF-8, a real conflict, or git failing).
 * `scratch` names a scratch file of a kind, which this removes after.
 */
export async function mergeOne(run: Run, scratch: (kind: string) => string, head: string, mergeBase: string, base: string, path: string): Promise<Blob | undefined> {
  const mode = (await run(['ls-tree', head, '--', path])).stdout.split(/\s/)[0];
  if (mode !== '100644') return undefined;
  const sides: string[] = [];
  try {
    for (const commit of [head, mergeBase, base]) {
      const blob = await run(['cat-file', 'blob', `${commit}:${path}`]);
      // A file not on this side, or not UTF-8 (read as text, it would not be written back as it was): not resolved.
      if (blob.code !== 0 || blob.stdout.includes('\uFFFD')) return undefined;
      const file = scratch('side');
      writeFileSync(file, blob.stdout);
      sides.push(file);
    }
    const merged = await run(['merge-file', '-p', '--diff3', `--marker-size=${MARKER}`, '-L', 'ours', '-L', 'base', '-L', 'theirs', ...sides]);
    // Its exit code is the number of conflicts, at most 127; above it git failed, and printed no merge (issue #1218).
    if (merged.code <= 0 || merged.code > 127 || !merged.stdout.includes(`${'<'.repeat(MARKER)} `)) return undefined;
    const text = keepBothAdditions(merged.stdout);
    if (text === undefined) return undefined;
    const file = scratch('blob');
    sides.push(file);
    writeFileSync(file, text);
    const r = await run(['hash-object', '-w', '--no-filters', file]);
    return r.code === 0 ? { path, mode, oid: r.stdout.trim(), lines: lineCount(text) } : undefined;
  } finally {
    for (const file of sides) rmSync(file, { force: true });
  }
}
