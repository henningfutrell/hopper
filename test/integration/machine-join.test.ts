// Issue #308 through the real composition root and the real HTTP server: adding a machine to a hopper
// is one copied line. An admin's Add machine mints a one-time join code; the machine runs the hopper
// client's join with `<hopper URL>#<code>`, and from then on dials in to the hopper's own URL — no ssh,
// no token variable, no restart, nothing typed into the hopper (design.md "Joining a machine").
//
// Feature: add a machine with one line
//   Scenario: a machine joins with the line, and is online
//     Given a hopper and an admin signed in to it
//     When the admin asks Add machine for a join code
//     And a machine runs the client's join with the hopper's URL and that code, then starts the client
//     Then the Machines view lists the machine under its own name, a client target, online
//     And the hopper's herdr calls run in the machine's herdr session
//   Scenario: a join code joins one machine, once
//   Scenario: a machine started again from its own files dials in as the same machine
//   Scenario: something holding another machine key cannot dial in as the machine
//   Scenario: a removed machine's next dial-in is refused
//   Scenario: the client install is served by the hopper
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startLinkedClient } from '../../src/client/main.ts';
import { joinHopper, readLink } from '../../src/client/join.ts';
import { linkToken, mintLinkKey, CONNECT_PATH, LINK_PROTOCOL, USER_HEADER, MACHINE_KEY_HEADER } from '../../src/client/link.ts';
import { readRelease } from '../../src/client/release.ts';
import type { Client } from '../../src/client/server.ts';
import { signConnect } from '../../src/client/signature.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { readConfig } from '../support/files.ts';
import { rawUpgrade } from '../support/http.ts';
import { waitFor } from '../support/wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const SRC = fileURLToPath(new URL('../../src/client', import.meta.url));

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

async function boot(): Promise<{ a: TestApp; session: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 2, executors: ['test'] } } });
  return { a: t, session: await t.login() };
}

/** A machine's own client dir: where its link key and link are kept. */
function machineDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hopper-machine-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function joinCode(a: TestApp, session: string): Promise<string> {
  const r = await a.ui<{ code: string; expiresAt: string }>('/ui/api/machines/join', {}, { token: session });
  expect(r.status).toBe(200);
  expect(r.body.code).toMatch(/^[0-9a-f]{64}$/);
  return r.body.code;
}

async function start(dir: string): Promise<Client> {
  const c = startLinkedClient({ dir, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [50] });
  clients.push(c);
  return c;
}

const machinesOf = async (a: TestApp) => (await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean; client?: unknown; ssh?: string; maxLanes: number; executors: string[] }[];
const online = (a: TestApp, name: string) => waitFor(async () => (await machinesOf(a)).find((m) => m.id === name && m.online), { timeoutMs: 10000, what: `${name} online` });
const herdrCalls = (): string[][] => {
  const file = join(process.env.FAKE_HERDR_DIR!, 'calls.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { argv: string[] }).argv) : [];
};

describe('adding a machine with one line', () => {
  it('a machine joins with the line and is online: a client target under its own name, its herdr session answering', async () => {
    const { a, session } = await boot();
    const dir = machineDir();
    const link = await joinHopper({ line: `${a.url}#${await joinCode(a, session)}`, name: 'studio', dir });
    expect(link).toMatchObject({ url: a.url, machine: 'studio' });
    // Its private half is its own: a file only its user may read.
    expect(statSync(join(dir, 'link-key.pem')).mode & 0o077).toBe(0);
    await start(dir);
    const m = await online(a, 'studio');
    expect(m).toMatchObject({ id: 'studio', maxLanes: 2, executors: ['test'], client: expect.any(Object) });
    expect(m.ssh).toBeUndefined();
    expect(herdrCalls()).toContainEqual(['--session', 'hopper', 'status', 'server']);
    // The plugins config records its machine key, never a secret.
    const cfg = (await a.api('GET', '/api/machines/config')).body;
    expect(JSON.stringify(cfg)).not.toContain(readFileSync(join(dir, 'link-key.pem'), 'utf8').split('\n')[1]);
  });

  it('a join code joins one machine, once: a second join with it is refused', async () => {
    const { a, session } = await boot();
    const line = `${a.url}#${await joinCode(a, session)}`;
    await joinHopper({ line, name: 'studio', dir: machineDir() });
    await expect(joinHopper({ line, name: 'laptop', dir: machineDir() })).rejects.toThrow(/join code is not valid/);
    expect((await machinesOf(a)).map((m) => m.id)).toEqual(['studio']);
  });

  it('a join code is minted only through an admin\'s UI session', async () => {
    const { a } = await boot();
    expect((await a.ui('/ui/api/machines/join', {})).status).toBe(403);
  });

  it('a second machine of the same name is given another', async () => {
    const { a, session } = await boot();
    await joinHopper({ line: `${a.url}#${await joinCode(a, session)}`, name: 'box', dir: machineDir() });
    const second = await joinHopper({ line: `${a.url}#${await joinCode(a, session)}`, name: 'box', dir: machineDir() });
    expect(second.machine).toBe('box-2');
  });

  it('a machine started again from its own files dials in as the same machine, even renamed', async () => {
    const { a, session } = await boot();
    const dir = machineDir();
    await joinHopper({ line: `${a.url}#${await joinCode(a, session)}`, name: 'studio', dir });
    const first = await start(dir);
    await online(a, 'studio');
    await first.stop();
    clients.splice(clients.indexOf(first), 1);
    const version = (await a.api('GET', '/api/machines/config')).body.version as string;
    const options = (readConfig(a.dbPath, 'plugins') as { machines: { name: string; options: object }[] }).machines.find((m) => m.name === 'studio')!.options;
    const r = await a.ui('/ui/api/plugins', { action: 'options', role: 'machine-source', name: 'studio', rename: 'workstation', options, version }, { token: session });
    expect(r.status).toBe(200);
    await start(dir);
    await online(a, 'workstation');
    expect((await machinesOf(a)).map((m) => m.id)).toEqual(['workstation']);
    expect(readLink(dir).machine).toBe('studio');
  });

  it('something without the machine\'s link key cannot dial in as it', async () => {
    const { a, session } = await boot();
    const dir = machineDir();
    const link = await joinHopper({ line: `${a.url}#${await joinCode(a, session)}`, name: 'studio', dir });
    const forged = mintLinkKey();
    const r = await rawUpgrade(a.url, CONNECT_PATH, {
      upgrade: LINK_PROTOCOL, [USER_HEADER]: link.user, [MACHINE_KEY_HEADER]: link.key,
      'x-hopper-signature': signConnect(linkToken(forged.privateKey, link.hopperKey), link.user, link.key),
    });
    expect(r.status).toBe(401);
    expect((await machinesOf(a)).find((m) => m.id === 'studio')?.online).toBe(false);
  });

  it('a removed machine\'s next dial-in is refused, and it stays gone', async () => {
    const { a, session } = await boot();
    const dir = machineDir();
    await joinHopper({ line: `${a.url}#${await joinCode(a, session)}`, name: 'studio', dir });
    const version = (await a.api('GET', '/api/machines/config')).body.version as string;
    expect((await a.ui('/ui/api/plugins', { action: 'remove', role: 'machine-source', name: 'studio', version }, { token: session })).status).toBe(200);
    const link = readLink(dir);
    // Signed with the machine's own token: the key it was is no machine's any more.
    const token = linkToken(readFileSync(join(dir, 'link-key.pem'), 'utf8'), link.hopperKey);
    const r = await rawUpgrade(a.url, CONNECT_PATH, { upgrade: LINK_PROTOCOL, [USER_HEADER]: link.user, [MACHINE_KEY_HEADER]: link.key, 'x-hopper-signature': signConnect(token, link.user, link.key) });
    expect(r.status).toBe(401);
    expect(await machinesOf(a)).toEqual([]);
  });

  it('the client install is served by the hopper: an install script, and the hopper\'s own client release', async () => {
    const { a } = await boot();
    const script = await fetch(`${a.url}/client/install`);
    expect(script.status).toBe(200);
    const text = await script.text();
    expect(text).toMatch(/^#!\/bin\/sh/);
    expect(text).toContain('/client/release');
    expect(text).toContain('join');
    const release = await (await fetch(`${a.url}/client/release`)).json() as { id: string; files: Record<string, string> };
    expect(release.id).toBe(readRelease(SRC).id);
    expect(Object.keys(release.files)).toContain('main.ts');
  });
});
