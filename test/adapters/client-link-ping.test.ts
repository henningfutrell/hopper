// The link's keepalive (issue #752, design.md "Link-lost hold"): both ends PING each other on the link. A link whose
// network went away without a FIN (half-open) is found dead within seconds on both ends: the hopper drops it, so a
// running job is held as link-lost and not failed after three herdr errors; the client dials in again. The client is
// real; between it and the hopper's end is a relay that can stop passing bytes without closing either socket.
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { mintToken } from '../../src/client/signature.ts';
import { startClient, type Client } from '../../src/client/server.ts';
import { createHerdrCliClient } from '../../src/executors/herdr/index.ts';
import { testInstallDir } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const TOKEN = mintToken();
const PING = { everyMs: 40, timeoutMs: 120 };

interface Rig { client: Client; link: () => Socket | undefined; dials: () => number; blackhole: () => void; stop: () => Promise<void> }

const listen = async (s: Server): Promise<number> => {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as { port: number }).port;
};

/** The client dials the relay; the relay passes bytes to the hopper's end until `blackhole`, then drops them both ways. */
async function rig(clientPing: typeof PING | undefined): Promise<Rig> {
  let link: Socket | undefined;
  const hopper = createServer((s) => { link?.destroy(); link = s; s.once('close', () => { if (link === s) link = undefined; }); });
  const hopperPort = await listen(hopper);
  const pairs: Socket[] = [];
  let dials = 0;
  let open = true;
  const relay = createServer((inbound) => {
    dials++;
    const outbound = connect(hopperPort, '127.0.0.1');
    pairs.push(inbound, outbound);
    inbound.on('data', (d) => { if (open) outbound.write(d); });
    outbound.on('data', (d) => { if (open) inbound.write(d); });
    inbound.on('error', () => {});
    outbound.on('error', () => {});
  });
  const relayPort = await listen(relay);
  const dial = (): Promise<Duplex> => new Promise((resolve, reject) => {
    const s = connect(relayPort, '127.0.0.1');
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  const client = startClient({
    token: () => TOKEN, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [20], dial,
    ...(clientPing ? { ping: clientPing } : {}),
  });
  await waitFor(() => link, { timeoutMs: 5000, what: 'the client to dial in' });
  return {
    client, link: () => link, dials: () => dials,
    blackhole: () => { open = false; },
    async stop() {
      await client.stop();
      for (const s of pairs) s.destroy();
      link?.destroy();
      await Promise.all([hopper, relay].map((s) => new Promise((r) => s.close(r))));
    },
  };
}

let r: Rig | undefined;
let dir: string | undefined;
const saved = { ...process.env };
afterEach(async () => {
  await r?.stop();
  r = undefined;
  process.env = { ...saved };
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const herdrVia = (rg: Rig, ping = PING) => createHerdrCliClient({ client: { machine: 'studio', link: () => rg.link(), token: () => TOKEN, ping } });

describe('the link keepalive', () => {
  it('a live, idle link stays up through many PINGs on both ends', async () => {
    dir = mkdtempSync(join(tmpdir(), 'jh-ping-'));
    process.env.FAKE_HERDR_DIR = dir;
    r = await rig(PING);
    const herdr = herdrVia(r);
    await herdr.getAgent('jh-a');
    const first = r.link();
    await new Promise((res) => setTimeout(res, 600));
    expect(r.link()).toBe(first);
    expect(herdr.linkDown?.()).toBe(false);
    expect(r.dials()).toBe(1);
    expect(await herdr.getAgent('jh-a')).toMatchObject({ status: 'idle' });
  });

  it('the hopper finds a half-open link dead within its PING timeout: the link is down, not only slow', async () => {
    dir = mkdtempSync(join(tmpdir(), 'jh-ping-'));
    process.env.FAKE_HERDR_DIR = dir;
    r = await rig({ everyMs: 60_000, timeoutMs: 60_000 });
    const herdr = herdrVia(r);
    await herdr.getAgent('jh-a');
    const first = r.link()!;
    r.blackhole();
    await waitFor(() => first.destroyed, { timeoutMs: 2000, what: 'the hopper to drop the dead link' });
    expect(herdr.linkDown?.()).toBe(true);
  });

  it('a PING not answered within its interval is a missed heartbeat, said to the herdr client\'s listeners before the drop (issue #1569)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'jh-ping-'));
    process.env.FAKE_HERDR_DIR = dir;
    r = await rig({ everyMs: 60_000, timeoutMs: 60_000 });
    const herdr = herdrVia(r);
    await herdr.getAgent('jh-a');
    const first = r.link()!;
    const said: string[] = [];
    const off = herdr.onLinkLate!(() => said.push(first.destroyed ? 'late after the drop' : 'late'));
    r.blackhole();
    await waitFor(() => first.destroyed, { timeoutMs: 2000, what: 'the hopper to drop the dead link' });
    expect(said).toEqual(['late']);
    off();
  });

  it('a live link says no missed heartbeat', async () => {
    dir = mkdtempSync(join(tmpdir(), 'jh-ping-'));
    process.env.FAKE_HERDR_DIR = dir;
    r = await rig(PING);
    // A PING is late when the next one is due, so the hopper's end PINGs at an interval a loaded CI worker's event loop
    // does not stall through; 40 ms did (issue #1991). The window still holds several PINGs.
    const herdr = herdrVia(r, { everyMs: 250, timeoutMs: 750 });
    const said: string[] = [];
    herdr.onLinkLate!(() => said.push('late'));
    await herdr.getAgent('jh-a');
    await new Promise((res) => setTimeout(res, 1200));
    expect(said).toEqual([]);
  });

  it('the client finds a half-open link dead and dials in again', async () => {
    r = await rig(PING);
    r.blackhole();
    await waitFor(() => r!.dials() >= 2, { timeoutMs: 2000, what: 'the client to dial in again' });
  });
});
