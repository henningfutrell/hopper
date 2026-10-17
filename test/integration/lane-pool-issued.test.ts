// Issue #1454 through the real composition root and the real HTTP server: a hopper that is not the chart's own (a compose
// hopper) issues a lane pool key with no restart — Add machine's Pod / Kubernetes —, and lane pods of a runner-only
// release join with it as the issuing user's machines (design.md "Lane pods of another release").
//
// Feature: lane pods join a hopper outside their release
//   Scenario: a hopper started with no lane pool key issues one; a pod joins with it, online, a lane pod
//   Scenario: a new key replaces the one before; a revoked key joins no pod, and the machines that joined stay
//   Scenario: only the hash is kept, and a GET answers when it was issued, never the key
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startLinkedClient } from '../../src/client/main.ts';
import { joinHopper } from '../../src/client/join.ts';
import type { Client } from '../../src/client/server.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);

let t: TestApp | undefined;
const clients: Client[] = [];
const cleanups: (() => void)[] = [];
const saved = { ...process.env };

afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop();
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
});

/** A hopper with no HOPPER_LANE_POOL_KEY: the install gave it none. */
async function boot(): Promise<{ a: TestApp; session: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 2, executors: ['test'] } } });
  return { a: t, session: await t.login() };
}

function volume(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hopper-lane-pod-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type Listed = { id: string; online: boolean };
const machinesOf = async (a: TestApp) => (await a.api('GET', '/api/machines')).body.machines as Listed[];
const poolOptions = async (a: TestApp) => ((await a.api('GET', '/api/machines/config')).body.machines as { name: string; options?: { pool?: boolean } }[]);
const issue = async (a: TestApp, session: string) => (await a.ui<{ key: string; issuedAt: string }>('/ui/api/machines/pool-key', { action: 'issue' }, { token: session })).body;

describe('lane pods of another release', () => {
  it('a hopper started with no lane pool key issues one; a pod joins with it, online, a lane pod', async () => {
    const { a, session } = await boot();
    const { key } = await issue(a, session);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const dir = volume();
    expect((await joinHopper({ line: `${a.url}#${key}`, name: 'runner-hopper-lanes-0', dir })).machine).toBe('runner-hopper-lanes-0');
    // Not spent: the pod's next start joins with it again.
    expect((await joinHopper({ line: `${a.url}#${key}`, name: 'runner-hopper-lanes-0', dir })).machine).toBe('runner-hopper-lanes-0');
    clients.push(startLinkedClient({ dir, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [50] }));
    await waitFor(async () => (await machinesOf(a)).find((m) => m.id === 'runner-hopper-lanes-0' && m.online), { timeoutMs: 10000, what: 'the pod online' });
    expect((await poolOptions(a)).map((m) => [m.name, m.options?.pool])).toEqual([['runner-hopper-lanes-0', true]]);
  });

  it('a new key replaces the one before; a revoked key joins no pod, and the machines that joined stay', async () => {
    const { a, session } = await boot();
    const first = (await issue(a, session)).key;
    const second = (await issue(a, session)).key;
    expect(second).not.toBe(first);
    await expect(joinHopper({ line: `${a.url}#${first}`, name: 'runner-hopper-lanes-0', dir: volume() })).rejects.toThrow(/join code is not valid/);
    await joinHopper({ line: `${a.url}#${second}`, name: 'runner-hopper-lanes-0', dir: volume() });
    expect((await a.ui('/ui/api/machines/pool-key', { action: 'revoke' }, { token: session })).body).toEqual({ revoked: true });
    await expect(joinHopper({ line: `${a.url}#${second}`, name: 'runner-hopper-lanes-1', dir: volume() })).rejects.toThrow(/join code is not valid/);
    expect((await poolOptions(a)).map((m) => m.name)).toEqual(['runner-hopper-lanes-0']);
    expect((await a.ui('/ui/api/machines/pool-key', { action: 'revoke' }, { token: session })).body).toEqual({ revoked: false });
  });

  it('only the hash is kept, and a GET answers when it was issued, never the key', async () => {
    const { a, session } = await boot();
    const read = async () => (await a.api('GET', '/api/machines/pool-key', undefined, { 'x-hopper-session': session })).body;
    expect(await read()).toEqual({});
    const { key, issuedAt } = await issue(a, session);
    const seen = await read();
    expect(seen).toEqual({ issuedAt });
    expect(JSON.stringify(seen)).not.toContain(key);
  });
});
