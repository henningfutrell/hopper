// The herdr-claude job payload: validation at push time, resolution at run time.

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MachineSnapshot } from '../../domain/types.ts';

export const DEFAULT_EXPECTED_MS = 600000;
export const DEFAULT_TIMEOUT_MS = 3600000;

export interface ClaudeJobPayload {
  prompt: string;
  cwd: string;
  model?: string;
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

/**
 * The work tree on the lane's machine (issue #323): `~` is that machine's home, this process's only
 * for this machine; an attached machine's is the one its probe found. An error when it is not known yet.
 */
export function workTreeOn(machine: MachineSnapshot, cwd: string): { cwd: string } | { error: string } {
  if (cwd !== '~' && !cwd.startsWith('~/')) return { cwd };
  const attached = machine.ssh !== undefined || machine.client !== undefined || machine.docker !== undefined;
  const home = attached ? machine.home : homedir();
  if (!home) return { error: `cannot resolve the work tree ${cwd} on ${machine.id}: its home is not known yet (the machine has not answered a probe)` };
  return { cwd: cwd === '~' ? home : join(home, cwd.slice(2)) };
}

/** Assumes a validated payload. `cwd` keeps its `~`: workTreeOn resolves it on the lane's machine. */
export function resolvePayload(payload: Record<string, unknown>, defaultCwd: string): ClaudeJobPayload {
  const p = payload as { prompt: string; cwd?: string; model?: string; env?: Record<string, string>; expectedMs?: number; timeoutMs?: number };
  return {
    prompt: p.prompt,
    cwd: p.cwd ?? defaultCwd,
    model: p.model,
    env: { ...(p.env ?? {}) },
    expectedMs: p.expectedMs ?? DEFAULT_EXPECTED_MS,
    timeoutMs: p.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}
