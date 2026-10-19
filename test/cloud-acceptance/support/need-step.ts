// A job's need steps in the cloud acceptance tests (issue #1956): asked on the hopper's step route as `hopper-step` asks
// them, with the job's proxy token, and read to their end; and the need boxes a hopper left at the container runtime.
import { execFileSync } from 'node:child_process';
import { expect } from 'vitest';
import { NEED_LABEL } from '../../../src/sandbox/need-box.ts';
import { openDb } from '../../../src/store/db.ts';
import { STEP_HEADER, STEP_PATH } from '../../../src/windows-steps/script.ts';
import { waitFor } from '../../support/wait.ts';
import type { CrashHost } from '../../crash/harness.ts';
import { cli } from './box.ts';

/** The instance id the hopper on the database at `url` has: its need boxes carry it. */
function instanceOf(url: string): string | undefined {
  const db = openDb(url);
  try { return (db.get('SELECT value FROM settings WHERE key = ?', 'instanceId') as { value: string } | undefined)?.value; } finally { db.close(); }
}

/** The need boxes and their home volumes of the hopper on the database at `url` that the runtime still holds. */
export async function leftAtRuntime(url: string): Promise<string[]> {
  const instance = instanceOf(url);
  if (!instance) return [];
  const label = `label=${NEED_LABEL}=${instance}`;
  const boxes = (await cli(['ps', '-a', '-q', '--filter', label])).stdout.split('\n').filter(Boolean);
  const homes = (await cli(['volume', 'ls', '-q', '--filter', label])).stdout.split('\n').filter(Boolean);
  return [...boxes, ...homes];
}

/** Removes each need box and home volume the hopper on the database at `url` left: a failed test's. */
export async function removeLeft(url: string): Promise<void> {
  for (const id of await leftAtRuntime(url)) await cli(['rm', '-f', '-t', '0', id]).then((r) => (r.code === 0 ? r : cli(['volume', 'rm', '-f', id])));
}

/** The files of `from` named, as a tar: a step's inputs. */
export function tarOf(from: string, files: string[]): Buffer {
  return execFileSync('tar', ['-cf', '-', '-C', from, ...files]);
}

export interface Ended { exit: number; problem: string | undefined; log: string; outputs: Buffer }

/** A job's request on `/job/step` as `hopper-step` sends it, with its inputs as the body. */
export async function asJob(h: CrashHost, method: string, path: string, body?: Buffer): Promise<Response> {
  return fetch(`${h.url}${path}`, {
    method, headers: { authorization: `Bearer ${h.job!.proxyToken}`, ...(body ? { 'content-type': 'application/x-tar' } : {}) },
    ...(body ? { body: new Uint8Array(body) } : {}),
  });
}

/** A need step asked and read to its end, within `ms`: its exit code, the hopper's problem, its log and its outputs. */
export async function step(h: CrashHost, q: { needs: string; key: string; command: string; planId?: string; output?: string[] }, inputs: Buffer, ms: number): Promise<Ended> {
  const params = new URLSearchParams({ needs: q.needs, key: q.key, command: q.command, timeout: String(ms / 1000) });
  if (q.planId) params.set('planId', q.planId);
  for (const o of q.output ?? []) params.append('output', o);
  const asked = await asJob(h, 'POST', `${STEP_PATH}?${params.toString()}`, inputs);
  const text = await asked.text();
  expect(asked.status, text).toBe(202);
  const id = asked.headers.get(STEP_HEADER.id)!;
  const result = await waitFor(async () => {
    const r = await asJob(h, 'GET', `${STEP_PATH}/${id}`);
    return r.status === 202 ? (await r.arrayBuffer(), undefined) : r;
  }, { timeoutMs: ms, intervalMs: 500, what: `step ${q.key} to end` });
  expect(result.status).toBe(200);
  const outputs = Buffer.from(await result.arrayBuffer());
  const log = await (await asJob(h, 'GET', `${STEP_PATH}/${id}/log?from=0`)).text();
  return { exit: Number(result.headers.get(STEP_HEADER.exit)), problem: result.headers.get(STEP_HEADER.problem) ?? undefined, log, outputs };
}
