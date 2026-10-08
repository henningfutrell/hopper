// The herdr-claude job payload: validation at push time, resolution at run time.

import { homedir } from 'node:os';
import { posix } from 'node:path';
import { JOBS_DIR, type Job, type MachineSnapshot } from '../../domain/types.ts';

export const DEFAULT_EXPECTED_MS = 600000;
export const DEFAULT_TIMEOUT_MS = 3600000;

export interface ClaudeJobPayload {
  prompt: string;
  cwd: string;
  model?: string;
  /** The work tree is the machine's (issue #361): the pane's shell makes it when missing. A job's own, a routing rule's, is never made. */
  makeWorkTree?: boolean;
  /** The job's repository (`owner/name`): fetched or cloned in the work tree before the agent starts (issue #361). */
  repo?: string;
  /** Extra environment for the job's tab (the executor adds HOPPER_JOB_ID). */
  env: Record<string, string>;
  expectedMs: number;
  timeoutMs: number;
}

const positive = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

function validateEnv(env: unknown): string | null {
  if (typeof env !== 'object' || env === null || Array.isArray(env)) return 'env must be an object of string values';
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== 'string') return 'env must be an object of string values';
    if (!ENV_KEY.test(k)) return `env key ${k} must match ^[A-Z_][A-Z0-9_]*$`;
    if (/[\r\n]/.test(v)) return `env value of ${k} must not contain a newline`;
  }
  return null;
}

const pathLike = (v: unknown): v is string => typeof v === 'string' && (v.startsWith('/') || v === '~' || v.startsWith('~/'));

export function validatePayload(payload: Record<string, unknown>): string | null {
  const { prompt, cwd, model, env, expectedMs, timeoutMs } = payload;
  if (typeof prompt !== 'string' || prompt.trim() === '') return 'prompt must be a non-empty string';
  if (cwd !== undefined && !pathLike(cwd)) return 'cwd must be an absolute path or start with ~';
  if (model !== undefined && typeof model !== 'string') return 'model must be a string';
  if (expectedMs !== undefined && !positive(expectedMs)) return 'expectedMs must be a positive number';
  if (timeoutMs !== undefined && !positive(timeoutMs)) return 'timeoutMs must be a positive number';
  return env === undefined ? null : validateEnv(env);
}

const normal = (path: string): string => posix.normalize(path).replace(/(.)\/+$/, '$1');

/**
 * The work tree on the lane's machine (issue #323): `~` is that machine's home, this process's only
 * for this machine; an attached machine's is the one its probe found, a Windows one with `/` for `\` (issue
 * #365). An error when it is not known yet,
 * and when the work tree is that home, above it, or the root (issue #314): a job never runs with the home
 * as its root.
 */
export function workTreeOn(machine: MachineSnapshot, cwd: string): { cwd: string } | { error: string } {
  const attached = machine.ssh !== undefined || machine.client !== undefined || machine.docker !== undefined;
  const home = (attached ? machine.home : homedir())?.replaceAll('\\', '/');
  const tilde = cwd === '~' || cwd.startsWith('~/');
  if (tilde && !home) return { error: `cannot resolve the work tree ${cwd} on ${machine.id}: its home is not known yet (the machine has not answered a probe)` };
  const resolved = normal(tilde ? posix.join(home!, cwd.slice(1)) : cwd);
  const ownHome = home ? normal(home) : undefined;
  if (resolved === '/' || (ownHome && (resolved === ownHome || ownHome.startsWith(`${resolved}/`)))) {
    return { error: `the work tree ${cwd} on ${machine.id} is its home or above it: a job runs only in a directory below the home; give the machine a work tree such as ${JOBS_DIR}` };
  }
  return { cwd: tilde ? resolved : cwd };
}

/**
 * Assumes a validated payload. The work tree is the lane's machine's (issue #361): the job's own `cwd`
 * (a routing rule's, which pins the job to its machine) only on the machine the job is pinned to, else
 * the machine's `workTree`, else the jobs directory. A path set for one machine never reaches another.
 * It keeps its `~`: workTreeOn resolves it on the lane's machine. `repo`: the job's GitHub repository, if
 * any: fetched or cloned in a work tree that is no repository (job-worktree.ts).
 */
export function resolvePayload(job: Pick<Job, 'spec' | 'source'>, machine: Pick<MachineSnapshot, 'id' | 'workTree'>): ClaudeJobPayload {
  const p = job.spec.payload as { prompt: string; cwd?: string; model?: string; env?: Record<string, string>; expectedMs?: number; timeoutMs?: number };
  const own = job.spec.machineId === machine.id ? p.cwd : undefined;
  return {
    prompt: p.prompt,
    cwd: own ?? machine.workTree ?? JOBS_DIR,
    ...(own === undefined ? { makeWorkTree: true } : {}),
    model: p.model,
    ...(job.source?.repo && job.source.kind.startsWith('github') ? { repo: job.source.repo } : {}),
    env: { ...(p.env ?? {}) },
    expectedMs: p.expectedMs ?? DEFAULT_EXPECTED_MS,
    timeoutMs: p.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}
