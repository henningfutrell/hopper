// The shrink guard (issue #1096, design.md "The shrink guard"): a job's push that brings its base branch into its branch
// — a rebase or a merge of the base, as a tend job's conflict resolution makes — is refused when it empties a file, or
// takes more than the guard's percent of a file's lines, that the branch's own change did not empty or shrink so; a file
// the branch's own change shrank but kept may still not be emptied, nor lose more than the percent of what the branch kept
// (issue #1218). The hopper's own base merge is judged the same way before it is pushed (git-mirror/mirrors.ts). A
// resolution once emptied docs/design.md and docs/glossary.md, its checks passed, and yolo mode would have merged it.
// Each file is compared with the base branch as the push brings it in, and with the branch's head before the push; a file
// the base branch itself removed or shrank is the base branch's change, not the push's. The job is refused with the files
// named, so it redoes the resolution; a job whose last push the guard refused does not end done. A file the branch added
// is its own, not judged (issue #2225). Pure.
import type { DomainEvent, Job } from './types.ts';
import type { Verdict } from './pull-requests.ts';

export interface ShrinkGuardSettings {
  /** A file that loses more than this percent of its lines is refused (1–100). Emptied or removed is refused at any percent. */
  percent: number;
}

export const DEFAULT_SHRINK_GUARD: ShrinkGuardSettings = { percent: 50 };
export const SHRINK_GUARD_PERCENT = { min: 1, max: 100 } as const;

/**
 * A file's lines at the four commits a push that brings in its base branch is judged by; undefined: no such file there.
 * `start`: where the branch's own change starts (its merge base with the base branch before the push); `head`: the branch
 * before the push; `base`: the base branch as the push brings it in (the merge base after the push); `pushed`: the push.
 */
export interface PushFileLines { path: string; start?: number; head?: number; base?: number; pushed?: number }

/** A file the push would empty or shrink: its lines before (on the base branch, or at the branch's head) and after. */
export interface ShrunkFile { path: string; from: number; to: number; against: 'base' | 'head' }

/** Whether going from `from` lines to `to` (undefined: removed) loses the file, or more than `percent` of its lines. */
export function loses(from: number | undefined, to: number | undefined, percent: number): boolean {
  if (from === undefined || from === 0) return false;
  const after = to ?? 0;
  return after === 0 || (from - after) * 100 > from * percent;
}

/** The files the push would empty or shrink, and the branch's own change did not (issues #1096, #1218). */
export function shrunkFiles(files: readonly PushFileLines[], percent: number): ShrunkFile[] {
  const out: ShrunkFile[] = [];
  const gone = (n: number | undefined) => n === undefined || n === 0;
  for (const f of files) {
    // A file the branch added, and the base branch does not have, is the pull request's own (issue #2225): a rebase may
    // rename it (a new number, when the base branch took the old one), empty or remove it.
    if (f.start === undefined && f.base === undefined) continue;
    if (loses(f.start, f.head, percent)) {
      // The branch's own change empties or removes it: what the pull request means to do.
      if (gone(f.head)) continue;
      // The branch's own change shrinks it (issue #1218): the push may not empty it, nor lose much more than the branch
      // kept, where the base branch did not empty or shrink it too.
      if ((gone(f.pushed) && !gone(f.base)) || (loses(f.head, f.pushed, percent) && !loses(f.start, f.base, percent))) {
        out.push({ path: f.path, from: f.head!, to: f.pushed ?? 0, against: 'head' });
      }
      continue;
    }
    if (loses(f.base, f.pushed, percent)) out.push({ path: f.path, from: f.base!, to: f.pushed ?? 0, against: 'base' });
    // The branch's own lines lost, where the base branch did not shrink the file either.
    else if (loses(f.head, f.pushed, percent) && !loses(f.start, f.base, percent)) out.push({ path: f.path, from: f.head!, to: f.pushed ?? 0, against: 'head' });
  }
  return out;
}

/** At most this many files are named in a refusal. */
export const SHRUNK_NAMED = 10;

/** Why the push is refused, on one line, as git shows it to the job (`! [remote rejected] … (<reason>)`). */
export function shrinkReason(shrunk: readonly ShrunkFile[], baseBranch: string): string {
  const named = shrunk.slice(0, SHRUNK_NAMED).map((f) => `${f.path} (${f.from} lines ${f.against === 'base' ? `on ${baseBranch}` : 'before this push'}, ${f.to} after)`);
  const more = shrunk.length > SHRUNK_NAMED ? `, and ${shrunk.length - SHRUNK_NAMED} more` : '';
  return `the shrink guard refused this push: it brings in ${baseBranch} and empties or shrinks files your pull request does not: `
    + `${named.join(', ')}${more}. Redo the resolution: keep the lines of both sides, then push again`;
}

/**
 * Why a job may not end done (issue #1096): its last push was refused by the shrink guard, and no push went through after.
 * `events`: the job's events, newest first. Undefined: it may.
 */
export function shrinkRefusalOf(events: readonly DomainEvent[], tend: boolean): string | undefined {
  const last = events.find((e) => e.data.op === 'git.push'
    && (e.type === 'github_proxy.done' || (e.type === 'github_proxy.refused' && Array.isArray(e.data.shrunk))));
  if (last?.type !== 'github_proxy.refused') return undefined;
  const files = (last.data.shrunk as ShrunkFile[]).map((f) => f.path);
  return `${tend ? 'tending failed: ' : ''}the shrink guard refused its last push, which emptied or shrank ${files.join(', ')}, and no push went through after`;
}

/** The verdict on a job that ended done (issue #1096): not done when the shrink guard refused its last push, else `judge`'s. */
export async function guardedVerdict(events: readonly DomainEvent[], job: Job, judge: () => Promise<Verdict>): Promise<Verdict> {
  const why = shrinkRefusalOf(events, job.spec.tend === true);
  return why === undefined ? judge() : { done: false, why };
}
