// The herdr-claude job payload: validation at push time, resolution at run time.

import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_EXPECTED_MS = 600000;
export const DEFAULT_TIMEOUT_MS = 3600000;

export interface ClaudeJobPayload {
  prompt: string;
  cwd: string;
  model?: string;
  expectedMs: number;
  timeoutMs: number;
}

const positive = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;
const pathLike = (v: unknown): v is string => typeof v === 'string' && (v.startsWith('/') || v === '~' || v.startsWith('~/'));

export function validatePayload(payload: Record<string, unknown>): string | null {
  const { prompt, cwd, model, expectedMs, timeoutMs } = payload;
  if (typeof prompt !== 'string' || prompt.trim() === '') return 'prompt must be a non-empty string';
  if (cwd !== undefined && !pathLike(cwd)) return 'cwd must be an absolute path or start with ~';
  if (model !== undefined && typeof model !== 'string') return 'model must be a string';
  if (expectedMs !== undefined && !positive(expectedMs)) return 'expectedMs must be a positive number';
  if (timeoutMs !== undefined && !positive(timeoutMs)) return 'timeoutMs must be a positive number';
  return null;
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/** Assumes a validated payload. */
export function resolvePayload(payload: Record<string, unknown>, defaultCwd: string): ClaudeJobPayload {
  const p = payload as { prompt: string; cwd?: string; model?: string; expectedMs?: number; timeoutMs?: number };
  return {
    prompt: p.prompt,
    cwd: expandHome(p.cwd ?? defaultCwd),
    model: p.model,
    expectedMs: p.expectedMs ?? DEFAULT_EXPECTED_MS,
    timeoutMs: p.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}
