// A pull request's diff as lines of a code block (issue #1169): each line a file header, a hunk, an added, a removed or
// an unchanged line. A file's header runs from its `diff --git` line to its first hunk, so a removed line that reads as a
// header line (`--- …`) inside a hunk is still a removed line.
import type { PullRequestDiff } from './wire.ts';

export type DiffLineKind = 'file' | 'hunk' | 'added' | 'removed' | 'same';
export interface DiffLine { text: string; kind: DiffLineKind }

export function diffLinesOf(diff: string): DiffLine[] {
  if (diff === '') return [];
  let header = false;
  return diff.replace(/\n$/, '').split('\n').map((text): DiffLine => {
    if (text.startsWith('diff --git ')) { header = true; return { text, kind: 'file' }; }
    if (text.startsWith('@@')) { header = false; return { text, kind: 'hunk' }; }
    if (header) return { text, kind: 'file' };
    return { text, kind: text.startsWith('+') ? 'added' : text.startsWith('-') ? 'removed' : 'same' };
  });
}

/** "2 files, +1 −1", and "cut short" when the hopper answered only its start. */
export function diffSummary(d: PullRequestDiff): string {
  const add = d.files.reduce((n, f) => n + f.additions, 0);
  const del = d.files.reduce((n, f) => n + f.deletions, 0);
  return `${d.files.length} ${d.files.length === 1 ? 'file' : 'files'}, +${add} −${del}${d.truncated ? ', cut short' : ''}`;
}
