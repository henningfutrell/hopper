// The hopper keeps its client targets on its own client release (issue #70): each probe asks the client
// which release it runs and loads the hopper's when it differs — never while a job runs on that
// machine, so no herdr call of a running job meets a client restarting. An old client, one that
// predates releases, stays online and is reported once: it is added again with Add machine.
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readRelease } from '../../src/client/release.ts';
import { mintToken } from '../../src/client/signature.ts';
import type { ClientTransport } from '../../src/executors/client.ts';
import { createClientReleaseKeeper } from '../../src/machines/client-release.ts';
import { startTestClient, type TestClient } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const SRC = fileURLToPath(new URL('../../src/client', import.meta.url));
const HOPPERS = readRelease(SRC);
const TOKEN = mintToken();

let dir: string;
let client: TestClient | undefined;
afterEach(async () => { await client?.stop(); client = undefined; rmSync(dir, { recursive: true, force: true }); });

async function olderClient(restartOnLoad = false): Promise<{ install: string; loaded: string[]; transport: ClientTransport }> {
  dir = mkdtempSync(join(tmpdir(), 'jh-keeper-'));
  process.env.FAKE_HERDR_DIR = dir;
  process.env.FAKE_HERDR_RUNNING = '1';
  const install = join(dir, 'hopper-client');
  cpSync(SRC, install, { recursive: true });
  writeFileSync(join(install, 'main.ts'), `${HOPPERS.files['main.ts']}// an older client\n`);
  const loaded: string[] = [];
  client = await startTestClient({ token: () => TOKEN, herdrBin: HERDR, session: 'hopper', installDir: install, onLoaded: (id) => { loaded.push(id); if (restartOnLoad) void client?.client.stop(); } });
  return { install, loaded, transport: client.transport(TOKEN) };
}

describe('keeping a client target on the hopper\'s release', () => {
  it('while a job runs there: online, reported as not current, nothing loaded', async () => {
    const { install, loaded, transport } = await olderClient();
    const lines: string[] = [];
    const keep = createClientReleaseKeeper({ release: HOPPERS, logger: { info: (l) => lines.push(l), warn: (l) => lines.push(l) } });
    const probe = await keep(transport, () => true);
    expect(probe).toMatchObject({ online: true, client: { current: false } });
    expect(loaded).toEqual([]);
    expect(readRelease(install).id).not.toBe(HOPPERS.id);
  });

  it('once no job runs there: the hopper\'s release is loaded, and the load is logged', async () => {
    const { install, loaded, transport } = await olderClient();
    const lines: string[] = [];
    const keep = createClientReleaseKeeper({ release: HOPPERS, logger: { info: (l) => lines.push(l), warn: (l) => lines.push(l) } });
    await keep(transport, () => false);
    await waitFor(() => (loaded.length > 0 ? true : undefined), { timeoutMs: 5000, what: 'the restart asked for' });
    expect(loaded).toEqual([HOPPERS.id]);
    expect(readRelease(install)).toEqual(HOPPERS);
    expect(lines.join('\n')).toMatch(new RegExp(`client studio: loaded release ${HOPPERS.id}`));
  });

  it('a client that ends its link to restart, as main.ts does, still gets its answer to the hopper first', async () => {
    const { loaded, transport } = await olderClient(true);
    const lines: string[] = [];
    const keep = createClientReleaseKeeper({ release: HOPPERS, logger: { info: (l) => lines.push(l), warn: (l) => lines.push(l) } });
    await keep(transport, () => false);
    await waitFor(() => (loaded.length > 0 ? true : undefined), { timeoutMs: 5000, what: 'the restart asked for' });
    expect(loaded).toEqual([HOPPERS.id]);
    expect(lines.join('\n')).toMatch(new RegExp(`client studio: loaded release ${HOPPERS.id}`));
    expect(lines.join('\n')).not.toMatch(/failed/);
  });

  it('the probe carries the home the client answered, so ~ in a work tree resolves there (issue #323)', async () => {
    const { transport } = await olderClient();
    const keep = createClientReleaseKeeper({ release: HOPPERS, logger: { info: () => {}, warn: () => {} } });
    expect(await keep(transport, () => true)).toMatchObject({ online: true, home: homedir() });
  });

  it('the probe carries the disk the client\'s home is on, so the UI warns before it fills (issue #401)', async () => {
    const { transport } = await olderClient();
    const keep = createClientReleaseKeeper({ release: HOPPERS, logger: { info: () => {}, warn: () => {} } });
    const { disk } = await keep(transport, () => true);
    expect(disk?.totalBytes).toBeGreaterThan(0);
  });

  it('a client not dialled in is offline, and nothing is tried', async () => {
    dir = mkdtempSync(join(tmpdir(), 'jh-keeper-'));
    const keep = createClientReleaseKeeper({ release: HOPPERS, logger: { info: () => {}, warn: () => {} } });
    await expect(keep({ machine: 'studio', link: () => undefined, token: () => TOKEN }, () => false)).rejects.toThrow(/not dialled in/);
  });
});
