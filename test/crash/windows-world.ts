// A Windows step (issue #1611, design.md "Windows sandbox steps") under the crash harness (issue #1954): a first hopper
// runs a job of issue #7, which asks for a step on the Windows host a person added; the hopper is killed at a kill point
// of the `windows-step` saga, or while the step runs, or while it compensates a step the job stopped. A second hopper on
// the same database ends the saga. The Windows host is the crash host's double (test/crash/windows-host.ts), whose files
// in the test's directory say what ran there and what is left.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { WindowsHost, WindowsHostsView } from '../../src/domain/types.ts';
import { sagaKillPoint } from '../../src/sagas/kill-points.ts';
import { openDb } from '../../src/store/db.ts';
import { STEP_HEADER, STEP_PATH, WINDOWS_STEP_SAGA } from '../../src/windows-steps/index.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { TEST_ACCOUNT_TOKEN } from '../support/github-account.ts';
import { rawRequest } from '../support/http.ts';
import { waitFor } from '../support/wait.ts';
import { endLeases, killedAt, startHost, type CrashHost } from './harness.ts';
import { runsOn, scratchLeft } from './windows-host.ts';

const REPO = 'octo/tools';
export const HOST: WindowsHost = { name: 'build-host', ssh: 'builder@winbox', hostKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl', workDir: 'C:\\work\\app' };
/** The job's key for its ask: the same each time the same step is asked. */
const KEY = 'crash-step-0001';
/** The most one scenario takes: two hoppers start, one is killed. */
export const SCENARIO_MS = 120_000;

const point = (step: string, at: 'before-do' | 'after-do' | 'before-compensate' | 'after-compensate'): string => sagaKillPoint(WINDOWS_STEP_SAGA, step, at);
/** The kill points of the saga's steps: before and after `run` and `sweep`. */
export const WINDOWS_STEP_KILL_POINTS: string[] = ['run', 'sweep'].flatMap((s) => [point(s, 'before-do'), point(s, 'after-do')]);
/** The kill points of the compensation of `run`, which a step the job stops passes. */
export const WINDOWS_COMPENSATION_KILL_POINTS: string[] = [point('run', 'before-compensate'), point('run', 'after-compensate')];

export interface WindowsWorld {
  url: string;
  /** Where the crash Windows host keeps what it did. */
  dir: string;
  github: FakeForge;
  /** A host; `job`: it pulls the job of #7 (the first host of a test). */
  host(o?: { killPoint?: string; job?: boolean }): Promise<CrashHost>;
  close(): Promise<void>;
}

/** A fresh database, the fake GitHub with octo/tools and its issue #7, and the Windows host's directory. */
export async function windowsWorld(): Promise<WindowsWorld> {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  github.tokens.set(TEST_ACCOUNT_TOKEN, 'owner');
  github.issues.push({ repo: REPO, number: 7, title: 'Build it', body: 'Please.', author: 'owner', labels: [] });
  const db = tempDbPath();
  const url = databaseUrlFor(db.dbPath);
  const dir = mkdtempSync(join(tmpdir(), 'crash-windows-'));
  return {
    url, dir, github,
    host: (h = {}) => startHost({
      dbPath: db.dbPath, databaseUrl: url, fakes: { github: github.url }, windows: dir,
      ...(h.job ? { connectGitHub: [REPO], job: `${REPO}#7` } : {}), ...(h.killPoint ? { killPoint: h.killPoint } : {}),
    }),
    close: async () => { await github.close(); db.cleanup(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** A person adds the Windows host in Settings → Windows hosts; `secrets`, the vault secrets it gives its steps. */
export async function addHost(h: CrashHost, secrets?: string[]): Promise<void> {
  const view = await h.get<WindowsHostsView>('/api/windows-hosts');
  expect((await h.ui('/ui/api/windows-hosts', { hosts: [{ ...HOST, ...(secrets ? { secrets } : {}) }], version: view.version })).status).toBe(200);
}

/** A job's request on `/job/step` as `hopper-step` sends it; a host killed meanwhile answers status 0. */
export async function asJob(h: CrashHost, proxyToken: string, method: string, path: string): Promise<{ status: number; headers: Record<string, unknown>; text: string }> {
  try {
    return await rawRequest(h.url, {
      method, path, ...(method === 'POST' ? { body: '' } : {}),
      headers: { authorization: `Bearer ${proxyToken}`, ...(method === 'POST' ? { 'content-type': 'application/x-tar' } : {}) },
    });
  } catch { return { status: 0, headers: {}, text: '' }; }
}

const ask = (h: CrashHost, proxyToken: string, command: string) =>
  asJob(h, proxyToken, 'POST', `${STEP_PATH}?${new URLSearchParams({ host: HOST.name, key: KEY, command }).toString()}`);

/** The one step kept, and its host lease. */
function keptStep(url: string): { id: string; leaseHost: string | null } {
  const db = openDb(url);
  try {
    const rows = db.all('SELECT id, lease_host AS "leaseHost" FROM windows_steps') as { id: string; leaseHost: string | null }[];
    expect(rows).toHaveLength(1);
    return rows[0]!;
  } finally { db.close(); }
}

/** The `windows-step` sagas, by key and state. */
export function stepSagas(url: string): { key: string; state: string }[] {
  const db = openDb(url);
  try { return db.all('SELECT key, state FROM sagas WHERE kind = ?', WINDOWS_STEP_SAGA) as { key: string; state: string }[]; } finally { db.close(); }
}

export interface Ended { exit: number; problem: string | undefined; saga: string }

/**
 * The scenario: a first hopper, whose job asks for a step, killed at `point` — or, with no point, killed while the step
 * runs; with `stop`, the job stops its running step and the hopper is killed while it compensates. A second hopper ends
 * the saga. Then the step ran on the host once, its host was swept and let go, and the job reads one result from the
 * second hopper: what it answers.
 */
export async function killedThenEnded(w: WindowsWorld, o: { point?: string; stop?: boolean }): Promise<Ended> {
  const a = await w.host({ job: true, ...(o.point ? { killPoint: o.point } : {}) });
  const job = a.job!;
  await addHost(a);
  const hang = o.stop === true || o.point === undefined;
  const asked = await ask(a, job.proxyToken, hang ? 'msbuild App.sln hang' : 'msbuild App.sln');
  if (hang) {
    expect(asked.status, asked.text).toBe(202);
    const id = String(asked.headers[STEP_HEADER.id]);
    await waitFor(() => (runsOn(w.dir).includes(id) ? true : undefined), { timeoutMs: 30_000, what: 'the step to run on the host' });
    if (o.stop) void asJob(a, job.proxyToken, 'DELETE', `${STEP_PATH}/${id}`);
    else await a.kill();
  }
  if (o.point) await killedAt(a, o.point);
  endLeases(w.url);
  const b = await w.host();
  const ended = await waitFor(() => {
    const sagas = stepSagas(w.url);
    return sagas.length === 1 && (sagas[0]!.state === 'done' || sagas[0]!.state === 'compensated') ? sagas[0]! : undefined;
  }, { timeoutMs: 60_000, what: 'the second hopper to end the step\'s saga' });
  const step = keptStep(w.url);
  expect(ended.key).toBe(step.id);
  expect(runsOn(w.dir)).toEqual([step.id]);
  expect(scratchLeft(w.dir, HOST.name)).toBe(false);
  expect(step.leaseHost).toBeNull();
  // The job's ask sent again is the same step; the job reads its one result.
  expect(String((await ask(b, job.proxyToken, 'msbuild App.sln')).headers[STEP_HEADER.id])).toBe(step.id);
  const result = await asJob(b, job.proxyToken, 'GET', `${STEP_PATH}/${step.id}`);
  expect(result.status, result.text).toBe(200);
  const problem = result.headers[STEP_HEADER.problem];
  return { exit: Number(result.headers[STEP_HEADER.exit]), problem: typeof problem === 'string' ? problem : undefined, saga: ended.state };
}
