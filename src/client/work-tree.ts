// A machine's work tree, made ready where it is (issue #361, design.md "Per-machine work trees"): made
// when missing and writable, never the home or above it. Here for this machine and for a client target's
// client, which imports nothing outside src/client; an ssh target runs the same check as a shell command
// (src/machines/attached.ts). The answer is what is wrong, or nothing.
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
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

/**
 * `mkdir -p`, one directory at a time from the deepest that exists: Node's recursive mkdirSync never returns
 * for a path under /proc (Node 26), and here it runs on the daemon's and the client's event loop.
 */
function makeDirs(path: string): void {
  const missing: string[] = [];
  for (let p = path; !existsSync(p); p = posix.dirname(p)) missing.unshift(p);
  for (const p of missing) {
    try { mkdirSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
}

/** Makes the work tree on this machine: undefined when it is there and writable, else what is wrong. */
export function makeWorkTree(workTree: string, home: string): string | undefined {
  const r = resolveWorkTree(workTree, home);
  if ('problem' in r) return r.problem;
  try {
    makeDirs(r.path);
    accessSync(r.path, constants.W_OK);
    return undefined;
  } catch (e) {
    return `its work tree ${workTree} cannot be made: ${(e as Error).message}`;
  }
}

/** A signed `/work-tree {workTree}` call answered (issue #361): the machine's work tree made, or what is wrong with it. */
export function workTreeCall(body: unknown, home: string): { status: number; payload: unknown } {
  const tree = (typeof body === 'object' && body !== null ? body : {}) as { workTree?: unknown };
  const w = tree.workTree;
  if (typeof w !== 'string' || !(w.startsWith('/') || w === '~' || w.startsWith('~/'))) return { status: 400, payload: { error: 'workTree must be an absolute path or start with ~' } };
  const problem = makeWorkTree(w, home);
  return { status: 200, payload: problem ? { workTreeProblem: problem } : {} };
}
