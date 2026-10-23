// Where a job's files are in its work tree (issue #1188, design.md "Work tree"): one place, `<work tree>/.worktrees`,
// git-ignored by its own `.gitignore` of `*`. The job worktrees are `.worktrees/<repository name>/<job id>`; the hopper's
// own areas beside them start with `@`, which no GitHub repository name holds: each job's scratch dir
// `.worktrees/@scratch/<job id>` and the shared dependencies `.worktrees/@deps/<lockfile hash>`. Never inside a
// repository's checkout but the work tree itself. src/client/ keeps the same names in its scripts (it imports nothing of
// hopper): test/domain/job-layout.test.ts holds the two together. Pure.

/** The work tree's one place for jobs: its job worktrees and the hopper's own areas. */
export const WORKTREES_DIR = '.worktrees';
/** The job scratch dirs, in `WORKTREES_DIR`. */
export const SCRATCH_AREA = '@scratch';
/** The shared dependencies, in `WORKTREES_DIR`. */
export const DEPS_AREA = '@deps';

/**
 * The layout before issue #1188, only so the reap and the sweep find what it left and remove it: the scratch dirs
 * `<work tree>/.hopper-scratch/<job id>` and the job worktrees `<work tree>/workspace/worktrees/<name>-<job id>`.
 * Nothing is made there.
 */
export const OLD_SCRATCH_DIR = '.hopper-scratch';
export const OLD_WORKTREES_DIR = 'workspace/worktrees';

const trimmed = (path: string): string => path.replace(/(.)\/+$/, '$1');

/** `<work tree>/.worktrees`. */
export const worktreesOf = (workTree: string): string => `${trimmed(workTree)}/${WORKTREES_DIR}`;
/** The work tree's scratch area, `<work tree>/.worktrees/@scratch`. */
export const scratchAreaOf = (workTree: string): string => `${worktreesOf(workTree)}/${SCRATCH_AREA}`;
/** The job's own scratch dir, `<work tree>/.worktrees/@scratch/<job id>`. */
export const jobScratchOf = (workTree: string, jobId: string): string => `${scratchAreaOf(workTree)}/${jobId}`;
/** The job's worktree, `<work tree>/.worktrees/<name>/<job id>`: `name` its repository's (`owner/name` or `name`). */
export const jobWorktreeAt = (workTree: string, name: string, jobId: string): string =>
  `${worktreesOf(workTree)}/${name.slice(name.lastIndexOf('/') + 1)}/${jobId}`;

/** The work tree a scratch dir of either layout is in, and its job; undefined for any other path. */
export function scratchParts(scratch: string): { workTree: string; jobId: string } | undefined {
  for (const area of [`/${WORKTREES_DIR}/${SCRATCH_AREA}/`, `/${OLD_SCRATCH_DIR}/`]) {
    const at = scratch.lastIndexOf(area);
    const jobId = at > 0 ? scratch.slice(at + area.length) : '';
    if (jobId && !jobId.includes('/')) return { workTree: scratch.slice(0, at), jobId };
  }
  return undefined;
}

/**
 * A job worktree of either layout, by its path: its work tree and its name (`<job id>`, or `<name>-<job id>` in the old
 * layout, which only a known job id splits). Undefined for any other path, and for the hopper's own areas.
 */
export function worktreeParts(path: string): { workTree: string; name: string; old: boolean } | undefined {
  const now = new RegExp(`^(/.*)/${WORKTREES_DIR.replace('.', '\\.')}/([^/@][^/]*)/([^/]+)$`).exec(path);
  if (now) return { workTree: now[1]!, name: now[3]!, old: false };
  const old = new RegExp(`^(/.*)/${OLD_WORKTREES_DIR}/([^/]+)$`).exec(path);
  return old ? { workTree: old[1]!, name: old[2]!, old: true } : undefined;
}

/**
 * The known job a job worktree is of: `<job id>` its name (issue #1188), or `<name>-<job id>` in the layout before, whose
 * name may hold `-` too, so each split is tried.
 */
export function worktreeJobOf<T>(path: string, jobOf: (id: string) => T | undefined): T | undefined {
  const tree = worktreeParts(path);
  if (!tree) return undefined;
  const name = tree.name;
  if (!tree.old) return jobOf(name);
  for (let at = name.indexOf('-'); at >= 0; at = name.indexOf('-', at + 1)) {
    const job = jobOf(name.slice(at + 1));
    if (job !== undefined) return job;
  }
  return undefined;
}
