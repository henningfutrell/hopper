// A machine's work tree, made ready where it is (issue #361, design.md "Per-machine work trees"): made
// when missing and writable, never the home or above it. Here for this machine and for a client target's
// client, which imports nothing outside src/client; an ssh target runs the same check as a shell command
// (src/machines/attached.ts). The answer is what is wrong, or nothing.
import { accessSync, constants, mkdirSync } from 'node:fs';
import { posix } from 'node:path';

/** The default work tree: the jobs directory, `~/hopper-jobs` on the job's machine (issue #314). Mirrors `JOBS_DIR`. */
export const DEFAULT_WORK_TREE = '~/hopper-jobs';

const normal = (path: string): string => posix.normalize(path).replace(/(.)\/+$/, '$1');

/** The work tree with `~` as `home`, or what is wrong: it is the home, above it, or the root. */
export function resolveWorkTree(workTree: string, home: string): { path: string } | { problem: string } {
  const tilde = workTree === '~' || workTree.startsWith('~/');
  const path = normal(tilde ? posix.join(home, workTree.slice(1)) : workTree);
  const own = normal(home);
  if (path === '/' || path === own || own.startsWith(`${path}/`)) {
    return { problem: `its work tree ${workTree} is its home or above it: a job runs only in a directory below the home` };
  }
  return { path };
}

/** Makes the work tree on this machine: undefined when it is there and writable, else what is wrong. */
export function makeWorkTree(workTree: string, home: string): string | undefined {
  const r = resolveWorkTree(workTree, home);
  if ('problem' in r) return r.problem;
  try {
    mkdirSync(r.path, { recursive: true });
    accessSync(r.path, constants.W_OK);
    return undefined;
  } catch (e) {
    return `its work tree ${workTree} cannot be made: ${(e as Error).message}`;
  }
}
