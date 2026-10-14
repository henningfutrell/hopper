// The shrink guard in the UI (issue #1096), pure: the panel's summary, its note, and the check of a new percent.
import type { ShrinkGuardSettings } from './wire.ts';

export const SHRINK_GUARD_NOTE = 'A job that rebases its branch, or merges the base branch into it, sometimes resolves a conflict by emptying a file. '
  + 'The hopper reads each such push before GitHub gets it. It refuses the push when it empties, removes or shrinks a file by more than this percent, '
  + 'and names the files, so the job does the resolution again. A file that your pull request itself empties or shrinks is never refused. '
  + 'A job that ends with its last push refused ends failed (tending failed), and its pull request is not merged.';

export const shrinkGuardSummary = (s: ShrinkGuardSettings): string => (s.percent >= 100
  ? 'A push that brings in the base branch is refused when it empties or removes a file.'
  : `A push that brings in the base branch is refused when it takes more than ${s.percent}% of a file's lines, or empties or removes the file.`);

/** A new percent from the field: a whole number from 1 to 100; `percent` absent when it is the saved one. */
export function percentDraft(saved: number, draft: string): { ok: true; percent?: number } | { ok: false; error: string } {
  const t = draft.trim();
  const n = Number(t);
  if (!/^\d+$/.test(t) || n < 1 || n > 100) return { ok: false, error: 'A whole number from 1 to 100' };
  return n === saved ? { ok: true } : { ok: true, percent: n };
}
