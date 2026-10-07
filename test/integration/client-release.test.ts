// Issue #70 through the real composition root: the hopper client is released from the hopper — the
// client files of the install it runs from (src/client) — and the hopper loads that release onto every
// client target that runs another, down the client's own signed link. The client writes it whole into
// its install dir and asks to be restarted (its unit restarts it). /api/machines says which release each
// client target runs and whether it is the hopper's. The client joined with a join code (issue #308).
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(m.client).toEqual({ release: HOPPERS.id, current: true });
    expect(loaded).toEqual([]);
  });
});
