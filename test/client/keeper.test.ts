// The hopper keeps its client targets on its own client release (issue #70): each probe asks the client
// which release it runs and loads the hopper's when it differs — never while a job runs on that
// machine, so no herdr call of a running job meets a client restarting. An old client, one that
// predates releases, stays online and is reported once: it is added again with Add machine.
import { execFile } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readRelease } from '../../src/client/release.ts';
import { mintToken } from '../../src/client/signature.ts';
import type { ClientTransport } from '../../src/executors/client.ts';
import { bridgeRelease } from '../../src/machines/client-bridge.ts';
import { createClientReleaseKeeper } from '../../src/machines/client-release.ts';
import * as field from '../fixtures/client-835e17bd3c9c6ac3/release.ts';
import { startClient as startFieldClient } from '../fixtures/client-835e17bd3c9c6ac3/server.ts';
import { startTestClient, type TestClient } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const SRC = fileURLToPath(new URL('../../src/client', import.meta.url));
/** A client release out in the field before manifests (issue #545): seven files, a fixed list in its release.ts. */
const FIELD = fileURLToPath(new URL('../fixtures/client-835e17bd3c9c6ac3', import.meta.url));
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

  // Issue #365: a client on Windows answers its os.homedir(), a drive-letter path with backslashes.
  it.each([
    ['C:\\Users\\far', 'C:/Users/far'],
    ['C:/Users/far', 'C:/Users/far'],
    ['relative\\home', undefined],
  ])('a client whose home is %s: the probe carries %s', async (answered, expected) => {
    const { transport } = await olderClient();
    const keep = createClientReleaseKeeper({ release: HOPPERS, logger: { info: () => {}, warn: () => {} } });
    const home = process.env.HOME;
    process.env.HOME = answered;
    try {
      const probe = await keep(transport, () => true);
      expect(probe.online).toBe(true);
      expect(probe.home).toBe(expected);
    } finally { process.env.HOME = home; }
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

  it('a client released before manifests (a fixed file list) gets the bridge, which starts the hopper\'s release (issue #545)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'jh-keeper-'));
    process.env.FAKE_HERDR_DIR = dir;
    process.env.FAKE_HERDR_RUNNING = '1';
    const install = join(dir, 'hopper-client');
    cpSync(FIELD, install, { recursive: true });
    const loaded: string[] = [];
    client = await startTestClient({ token: () => TOKEN, herdrBin: HERDR, session: 'hopper', installDir: install, start: startFieldClient, onLoaded: (id) => loaded.push(id) });
    const lines: string[] = [];
    const keep = createClientReleaseKeeper({ release: HOPPERS, logger: { info: (l) => lines.push(l), warn: (l) => lines.push(l) } });
    const probe = await keep(client.transport(TOKEN), () => false);
    expect(probe).toMatchObject({ online: true, client: { release: '835e17bd3c9c6ac3', current: false } });
    expect(probe.client).not.toHaveProperty('update');
    const bridge = bridgeRelease(HOPPERS, field.CLIENT_FILES);
    await waitFor(() => (loaded.length > 0 ? true : undefined), { timeoutMs: 5000, what: 'the restart asked for' });
    expect(loaded).toEqual([bridge.id]);
    expect(lines.join('\n')).toMatch(/client studio: runs release 835e17bd3c9c6ac3, which checks a fixed file list: loaded the bridge/);
    // What its unit does on exit 75: start main.ts again — the bridge, which unpacks the hopper's release.
    await client.stop();
    client = undefined;
    const code = await new Promise<number>((r) => execFile(process.execPath, [join(install, 'main.ts')], { cwd: dir }, (e) => r(e ? Number((e as { code?: number }).code) : 0)));
    expect(code).toBe(75);
    expect(readRelease(install)).toEqual(HOPPERS);
  });

  it('a client the load does not take on, three times: no fourth load, and the probe says why, for Machines (issue #545)', async () => {
    const { loaded, transport } = await olderClient();
    const lines: string[] = [];
    const keep = createClientReleaseKeeper({ release: HOPPERS, logger: { info: (l) => lines.push(l), warn: (l) => lines.push(l) } });
    for (let i = 1; i <= 3; i++) {
      const p = await keep(transport, () => false);
      expect(p.client).not.toHaveProperty('update');
      await waitFor(() => (loaded.length === i ? true : undefined), { timeoutMs: 5000, what: `load ${i}` });
    }
    const stuck = await keep(transport, () => false);
    expect(loaded).toHaveLength(3);
    expect(stuck).toMatchObject({ online: true, client: { current: false, update: { problem: expect.stringMatching(/still runs release [0-9a-f]{16} after 3 loads of the hopper's/) } } });
    expect(lines.join('\n')).toMatch(/client studio: cannot update/);
  });

  it('a load the client refuses: the cause, in the client\'s words, is what Machines shows once the tries are spent', async () => {
    const { transport } = await olderClient();
    const keep = createClientReleaseKeeper({ release: { ...HOPPERS, id: '0123456789abcdef' }, logger: { info: () => {}, warn: () => {} } });
    for (let i = 0; i < 3; i++) await keep(transport, () => false);
    const stuck = await keep(transport, () => false);
    expect(stuck.client?.update?.problem).toMatch(/refused the hopper's release: .*id 0123456789abcdef/);
  });
});
