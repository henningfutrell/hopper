// Issue #1284 through the real composition root and the real HTTP server: lane pods — a StatefulSet's — join the hopper
// by dialling out, with the lane pool key the install gives the hopper (HOPPER_LANE_POOL_KEY) and the pods. Each is one
// machine under its pod's name; a pod started again is the same machine; a pod told to stop leaves, and with no job
// left on it is retired (design.md "Lane pods").
//
// Feature: lane pods register by dialling out
//   Scenario: three pods join with the one lane pool key: three machines, online, under their pods' names
//   Scenario: a pod started again joins again as the same machine, with its volume or without it
//   Scenario: a wrong key, or a hopper with no lane pool, refuses the join
//   Scenario: before anyone signed in, a pod's join is refused (its join step tries again)
//   Scenario: a pod that leaves with no job on it is retired; any other machine that leaves only takes no new job
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startLinkedClient } from '../../src/client/main.ts';
import { joinHopper } from '../../src/client/join.ts';
import type { Client } from '../../src/client/server.ts';
import type { LeaveAnswer } from '../../src/client/leave.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { newHopper } from '../support/database.ts';
import { waitFor } from '../support/wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const POOL_KEY = 'a1'.repeat(32);

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

async function boot(o: { poolKey?: string; signIn?: boolean } = {}): Promise<{ a: TestApp; session?: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  // No sign-in: a new hopper, with no user at all (issue #238).
  if (o.signIn === false) newHopper(db.dbPath);
  t = await startTestApp({
    dbPath: db.dbPath, ...(o.poolKey ? { secrets: { HOPPER_LANE_POOL_KEY: o.poolKey } } : {}),
    ...(o.signIn === false ? {} : { plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 2, executors: ['test'] } } }),
  });
  return { a: t, ...(o.signIn === false ? {} : { session: await t.login() }) };
}

/** A pod's volume: where its client dir, with its link key and link, is kept. */
function volume(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hopper-lane-pod-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function start(dir: string): Client & { leave(): Promise<LeaveAnswer> } {
  const c = startLinkedClient({ dir, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [50] });
  clients.push(c);
  return c;
}

type Listed = { id: string; online: boolean; leaving?: true };
const machinesOf = async (a: TestApp) => (await a.api('GET', '/api/machines')).body.machines as Listed[];
const online = (a: TestApp, name: string) => waitFor(async () => (await machinesOf(a)).find((m) => m.id === name && m.online), { timeoutMs: 10000, what: `${name} online` });
const poolOptions = async (a: TestApp) => ((await a.api('GET', '/api/machines/config')).body.machines as { name: string; options?: { pool?: boolean; key?: string } }[]);

describe('lane pods that join by dialling out', () => {
  it('three pods join with the one lane pool key: three machines, online, under their pods\' names', async () => {
    const { a } = await boot({ poolKey: POOL_KEY });
    const line = `${a.url}#${POOL_KEY}`;
    for (const pod of ['hopper-lanes-0', 'hopper-lanes-1', 'hopper-lanes-2']) {
      const dir = volume();
      expect((await joinHopper({ line, name: pod, dir })).machine).toBe(pod);
      start(dir);
    }
    for (const pod of ['hopper-lanes-0', 'hopper-lanes-1', 'hopper-lanes-2']) await online(a, pod);
    expect((await machinesOf(a)).map((m) => m.id).sort()).toEqual(['hopper-lanes-0', 'hopper-lanes-1', 'hopper-lanes-2']);
    expect((await poolOptions(a)).every((m) => m.options?.pool === true)).toBe(true);
  });

  it('a pod started again joins again as the same machine: with its volume, and with a new one', async () => {
    const { a } = await boot({ poolKey: POOL_KEY });
    const line = `${a.url}#${POOL_KEY}`;
    const dir = volume();
    await joinHopper({ line, name: 'hopper-lanes-0', dir });
    // Its volume kept: the same key, the same machine.
    expect((await joinHopper({ line, name: 'hopper-lanes-0', dir })).machine).toBe('hopper-lanes-0');
    // Its volume lost: a new key under the same name is still that machine, the old key no machine's.
    const before = (await poolOptions(a))[0]!.options!.key;
    const fresh = volume();
    expect((await joinHopper({ line, name: 'hopper-lanes-0', dir: fresh })).machine).toBe('hopper-lanes-0');
    const after = await poolOptions(a);
    expect(after.map((m) => m.name)).toEqual(['hopper-lanes-0']);
    expect(after[0]!.options!.key).not.toBe(before);
    start(fresh);
    await online(a, 'hopper-lanes-0');
  });

  it('a pod of the same name as a machine that is no lane pod is given another name', async () => {
    const { a, session } = await boot({ poolKey: POOL_KEY });
    const code = (await a.ui<{ code: string }>('/ui/api/machines/join', {}, { token: session })).body.code;
    await joinHopper({ line: `${a.url}#${code}`, name: 'hopper-lanes-0', dir: volume() });
    expect((await joinHopper({ line: `${a.url}#${POOL_KEY}`, name: 'hopper-lanes-0', dir: volume() })).machine).toBe('hopper-lanes-0-2');
  });

  it('a wrong key, or a hopper with no lane pool, refuses the join', async () => {
    const { a } = await boot({ poolKey: POOL_KEY });
    await expect(joinHopper({ line: `${a.url}#${'b2'.repeat(32)}`, name: 'hopper-lanes-0', dir: volume() })).rejects.toThrow(/join code is not valid/);
    await t!.stop();
    t = undefined;
    const { a: none } = await boot();
    await expect(joinHopper({ line: `${none.url}#${POOL_KEY}`, name: 'hopper-lanes-0', dir: volume() })).rejects.toThrow(/join code is not valid/);
    expect(await machinesOf(none)).toEqual([]);
  });

  it('before anyone signed in, a pod\'s join is refused: it tries again until someone has', async () => {
    const { a } = await boot({ poolKey: POOL_KEY, signIn: false });
    await expect(joinHopper({ line: `${a.url}#${POOL_KEY}`, name: 'hopper-lanes-0', dir: volume() })).rejects.toThrow(/\(409\).*nobody has signed in yet/);
  });

  it('a pod that leaves with no job on it is retired; it joins again as the same machine', async () => {
    const { a } = await boot({ poolKey: POOL_KEY });
    const line = `${a.url}#${POOL_KEY}`;
    const dir = volume();
    await joinHopper({ line, name: 'hopper-lanes-0', dir });
    const pod = start(dir);
    await online(a, 'hopper-lanes-0');
    expect(await pod.leave()).toEqual({ jobs: 0, retired: true });
    expect(await machinesOf(a)).toEqual([]);
    // Started again: its join step joins it again, under its name.
    expect((await joinHopper({ line, name: 'hopper-lanes-0', dir })).machine).toBe('hopper-lanes-0');
    expect((await machinesOf(a)).map((m) => m.id)).toEqual(['hopper-lanes-0']);
  });

  it('a machine that is no lane pod and leaves stays, leaving, until it dials in again', async () => {
    const { a, session } = await boot({ poolKey: POOL_KEY });
    const code = (await a.ui<{ code: string }>('/ui/api/machines/join', {}, { token: session })).body.code;
    const dir = volume();
    await joinHopper({ line: `${a.url}#${code}`, name: 'studio', dir });
    const first = start(dir);
    await online(a, 'studio');
    expect(await first.leave()).toEqual({ jobs: 0, retired: false });
    expect((await machinesOf(a)).find((m) => m.id === 'studio')?.leaving).toBe(true);
    await first.stop();
    clients.splice(clients.indexOf(first), 1);
    start(dir);
    await waitFor(async () => (await machinesOf(a)).find((m) => m.id === 'studio' && m.online && !m.leaving), { timeoutMs: 10000, what: 'studio back, not leaving' });
  });

  it('a leave not signed with the machine\'s own token is refused', async () => {
    const { a } = await boot({ poolKey: POOL_KEY });
    const link = await joinHopper({ line: `${a.url}#${POOL_KEY}`, name: 'hopper-lanes-0', dir: volume() });
    const r = await fetch(`${a.url}/client/leave`, { method: 'POST', headers: { 'x-hopper-user': link.user, 'x-hopper-machine-key': link.key, 'x-hopper-signature': `ts=${Date.now()},nonce=00,sig=forged` } });
    expect(r.status).toBe(401);
    expect((await machinesOf(a)).map((m) => m.id)).toEqual(['hopper-lanes-0']);
  });
});
