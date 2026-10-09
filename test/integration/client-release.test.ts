// Issue #70 through the real composition root: the hopper client is released from the hopper — the
// client files of the install it runs from (src/client) — and the hopper loads that release onto every
// client target that runs another, down the client's own signed link. The client writes it whole into
// its install dir and asks to be restarted (its unit restarts it). /api/machines says which release each
// client target runs and whether it is the hopper's. The client joined with a join code (issue #308).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { startLinkedClient } from '../../src/client/main.ts';
import { readRelease } from '../../src/client/release.ts';
import type { Client } from '../../src/client/server.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const SRC = fileURLToPath(new URL('../../src/client', import.meta.url));
const HOPPERS = readRelease(SRC);
/** A client release out in the field before manifests (issue #545): seven files, a fixed list in its release.ts. */
const FIELD = fileURLToPath(new URL('../fixtures/client-835e17bd3c9c6ac3', import.meta.url));

let t: TestApp | undefined;
let server: Client | undefined;
const cleanups: (() => void)[] = [];
const saved = { ...process.env };

afterEach(async () => {
  await server?.stop();
  await t?.stop();
  t = undefined;
  server = undefined;
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
});

/** A client install dir holding the hopper's release, or one a line older. */
function installDir(older: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'jh-client-install-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const install = join(dir, 'hopper-client');
  cpSync(SRC, install, { recursive: true });
  if (older) writeFileSync(join(install, 'main.ts'), `${HOPPERS.files['main.ts']}// an older client\n`);
  return install;
}

async function boot(install: string): Promise<{ a: TestApp; loaded: string[] }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const dataDir = dirname(db.dbPath);
  process.env.FAKE_HERDR_DIR = dataDir;
  process.env.FAKE_HERDR_RUNNING = '1';
  t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [{ name: 'local', plugin: 'local' }], machineDefaults: { lanes: 1, executors: ['test'] } } });
  const code = (await t.ui<{ code: string }>('/ui/api/machines/join', {}, { token: await t.login() })).body.code;
  const dir = join(dirname(install), 'client-dir');
  await joinHopper({ line: `${t.url}#${code}`, name: 'studio', dir });
  const loaded: string[] = [];
  server = startLinkedClient({ dir, herdrBin: HERDR, session: 'hopper', installDir: install, backoffMs: [50], onLoaded: (id) => loaded.push(id) });
  return { a: t, loaded };
}

const studio = async (a: TestApp) => (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string }) => m.id === 'studio');

describe('the hopper client, released from the hopper and loaded onto client targets', () => {
  it('a client running another release gets the hopper\'s: written whole into its install dir, then a restart asked for', async () => {
    const install = installDir(true);
    const older = readRelease(install).id;
    expect(older).not.toBe(HOPPERS.id);
    const { a, loaded } = await boot(install);
    await waitFor(() => (loaded.length > 0 ? true : undefined), { timeoutMs: 10000, what: 'the release loaded' });
    expect(loaded).toEqual([HOPPERS.id]);
    expect(readRelease(install)).toEqual(HOPPERS);
    // Until its unit restarts it, the client still runs the release it started with.
    const m = await studio(a);
    expect(m).toMatchObject({ online: true, client: { release: older, current: false } });
  });

  it('a client already running the hopper\'s release is left alone, and says so', async () => {
    const install = installDir(false);
    const { a, loaded } = await boot(install);
    const m = await waitFor(async () => { const s = await studio(a); return s?.client?.release ? s : undefined; }, { timeoutMs: 10000, what: 'studio\'s release' });
    // Its vault's helper too (issue #558): the path the hopper gives its jobs as HOPPER_SECRET.
    expect(m.client).toEqual({ release: HOPPERS.id, current: true, vault: expect.stringMatching(/\/hopper-secret$/) });
    expect(loaded).toEqual([]);
  });
});

describe('a client out in the field before manifests updates itself (issue #545)', () => {
  it('joined on release 835e17bd3c9c6ac3, run as its unit runs it: the bridge, then the hopper\'s release, with nobody touching it', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const dataDir = dirname(db.dbPath);
    t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [{ name: 'local', plugin: 'local' }], machineDefaults: { lanes: 1, executors: ['test'] } } });
    const a = t;
    const code = (await a.ui<{ code: string }>('/ui/api/machines/join', {}, { token: await a.login() })).body.code;
    const root = mkdtempSync(join(tmpdir(), 'jh-field-client-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const install = join(root, 'hopper-client');
    cpSync(FIELD, install, { recursive: true });
    // herdr on the client's PATH, as on a computer.
    const bin = join(root, 'bin');
    mkdirSync(bin);
    symlinkSync(HERDR, join(bin, 'herdr'));
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOPPER_CLIENT_DIR: join(root, 'client-dir'), HOPPER_CLIENT_SESSION: 'hopper', FAKE_HERDR_DIR: dataDir, FAKE_HERDR_RUNNING: '1' };
    const node = (args: string[]): ChildProcess => spawn(process.execPath, [join(install, 'main.ts'), ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const joined = node(['join', `${a.url}#${code}`, 'studio']);
    expect(await new Promise((r) => joined.once('exit', r))).toBe(0);
    // The unit: Restart=always; the loop a box or a Windows computer runs: start it again on 75.
    const exits: number[] = [];
    let child: ChildProcess | undefined;
    let stopped = false;
    const run = (): void => {
      child = node([]);
      child.once('exit', (c) => { exits.push(c ?? -1); if (!stopped && c === 75) run(); });
    };
    run();
    cleanups.push(() => { stopped = true; child?.kill('SIGKILL'); });
    const m = await waitFor(async () => { const s = await studio(a); return s?.client?.current ? s : undefined; }, { timeoutMs: 30000, what: 'studio on the hopper\'s release' });
    expect(m).toMatchObject({ online: true, client: { release: HOPPERS.id, current: true } });
    expect(m.client).not.toHaveProperty('update');
    // The field release restarted into the bridge, the bridge into the hopper's release.
    expect(exits).toEqual([75, 75]);
    expect(readRelease(install)).toEqual(HOPPERS);
  }, 60000);
});

describe('the install line without a join code: a joined computer\'s client reinstalled (issue #545)', () => {
  const SCRIPT = fileURLToPath(new URL('../../scripts/client-install.sh', import.meta.url));

  /** A computer's home with the field client installed; joined when `joined`. No systemd on its PATH: only node and herdr. */
  function computer(joined: boolean): { home: string; env: NodeJS.ProcessEnv } {
    const home = mkdtempSync(join(tmpdir(), 'jh-reinstall-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    cpSync(FIELD, join(home, '.local', 'lib', 'hopper-client'), { recursive: true });
    if (joined) { mkdirSync(join(home, '.config', 'hopper-client'), { recursive: true }); writeFileSync(join(home, '.config', 'hopper-client', 'link.json'), '{}'); }
    const bin = join(home, 'bin');
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'node'));
    symlinkSync(HERDR, join(bin, 'herdr'));
    return { home, env: { HOME: home, PATH: bin } };
  }
  const install = (env: NodeJS.ProcessEnv, line: string): Promise<{ code: number; out: string }> => new Promise((r) => {
    execFile('/bin/sh', [SCRIPT, line], { env, encoding: 'utf8', timeout: 30000 }, (e, stdout, stderr) => r({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, out: stdout + stderr }));
  });

  it('writes the hopper\'s release over the old one, joins nothing, and says to restart the client', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    t = await startTestApp({ dbPath: db.dbPath });
    const { home, env } = computer(true);
    const run = await install(env, t.url);
    expect(run.code, run.out).toBe(0);
    expect(readRelease(join(home, '.local', 'lib', 'hopper-client'))).toEqual(HOPPERS);
    expect(run.out).toContain(`client release ${HOPPERS.id}`);
    expect(run.out).not.toMatch(/joined/);
    expect(run.out).toMatch(/restart/);
  });

  it('on a computer that never joined: refused, and says to use the line from Add machine', async () => {
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    t = await startTestApp({ dbPath: db.dbPath });
    const { home, env } = computer(false);
    const run = await install(env, t.url);
    expect(run.code).toBe(1);
    expect(run.out).toMatch(/has not joined.*Add machine/);
    expect(readRelease(join(home, '.local', 'lib', 'hopper-client')).id).not.toBe(HOPPERS.id);
  });
});
