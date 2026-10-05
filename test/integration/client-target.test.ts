// Issue #59 through the real composition root: a client target — a machine running the hopper
// client, connected back to this one over a reverse tunnel — is online while the client answers the
// hopper's signed herdr calls through the tunnel's socket (<dataDir>/clients/<name>.sock), and offline
// while nothing there can prove itself with the client's token. The tunnel is ssh -R
// (scripts/attach-client.sh); here the real client server listens at its end. herdr is the stand-in.
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from '../../src/client/server.ts';
import { mintToken } from '../../src/client/signature.ts';
import { clientSocket } from '../../src/executors/client.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { startTestClient } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const TOKEN = mintToken();

let t: TestApp | undefined;
let server: Client | undefined;
let cleanup: (() => void) | undefined;
const saved = { ...process.env };

afterEach(async () => {
  await t?.stop();
  await server?.stop();
  t = undefined;
  server = undefined;
  cleanup?.();
  process.env = { ...saved };
});

/** The app, with the client already at its tunnel's end when `clientToken` is given (the first probe is at boot). */
async function boot(daemonToken: string | undefined, clientToken?: string): Promise<{ a: TestApp; dataDir: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const dataDir = dirname(db.dbPath);
  process.env.FAKE_HERDR_DIR = dataDir;
  process.env.FAKE_HERDR_RUNNING = '1';
  if (clientToken) {
    mkdirSync(join(dataDir, 'clients'), { recursive: true, mode: 0o700 });
    server = await startTestClient(clientSocket(dataDir, 'studio'), { token: () => clientToken, herdrBin: HERDR, session: 'hopper' });
  }
  t = await startTestApp({
    dbPath: db.dbPath,
    plugins: {
      executors: [{ name: 'test', plugin: 'test' }],
      attachedMachines: [{ name: 'studio', client: { tokenEnv: 'STUDIO_CLIENT_TOKEN' }, lanes: 2, executors: ['test'] }],
    },
    secrets: daemonToken ? { STUDIO_CLIENT_TOKEN: daemonToken } : {},
  });
  return { a: t, dataDir };
}

const studio = async (a: TestApp) => (await a.api('GET', '/api/machines')).body.machines.find((m: { id: string }) => m.id === 'studio');

describe('a client target reached through its reverse tunnel', () => {
  it('online while the client answers the hopper\'s signed calls; /api/machines says it is a client target', async () => {
    const { a } = await boot(TOKEN, TOKEN);
    const m = await waitFor(async () => { const s = await studio(a); return s?.online ? s : undefined; }, { timeoutMs: 10000, what: 'studio online' });
    expect(m).toMatchObject({ id: 'studio', maxLanes: 2, executors: ['test'], client: { tokenEnv: 'STUDIO_CLIENT_TOKEN' } });
    expect(m.ssh).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain(TOKEN);
  });

  it('the hopper holds another token than the client: offline, never online', async () => {
    const { a } = await boot(mintToken(), TOKEN);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await studio(a)).online).toBe(false);
  });

  it('no token in the hopper\'s environment, or no tunnel: offline', async () => {
    const { a } = await boot(undefined);
    await new Promise((r) => setTimeout(r, 1000));
    expect((await studio(a)).online).toBe(false);
  });
});
