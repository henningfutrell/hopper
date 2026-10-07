// The herdr CLI client on a client target (issues #59, #308, design.md "Client targets"): every herdr call
// goes over HTTP/2 down the machine's link — the socket its client dialled in on — signed with the client
// token; an answer the client did not sign is not believed. The client is real; the hopper's end is a
// loopback server standing for the hopper's links. herdr is the stand-in.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createH2Server } from 'node:http2';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintToken } from '../../src/client/signature.ts';
import { HerdrError, createHerdrCliClient } from '../../src/executors/herdr/index.ts';
import { startTestClient, type TestClient } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const TOKEN = mintToken();

let dir: string;
let client: TestClient | undefined;
const saved = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-ct-'));
  process.env.FAKE_HERDR_DIR = dir;
});
afterEach(async () => {
  await client?.stop();
  client = undefined;
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

const hopper = (token = TOKEN) => createHerdrCliClient({ client: client!.transport(token) });
const serve = async (token = TOKEN) => { client = await startTestClient({ token: () => token, herdrBin: HERDR, session: 'hopper' }); };
const herdrCalls = (): string[][] => (existsSync(join(dir, 'calls.jsonl'))
  ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { argv: string[] }).argv) : []);

describe('herdr over a client target', () => {
  it('herdr calls run in the client\'s own herdr session, and results come back as they do locally', async () => {
    await serve();
    expect(await hopper().getAgent('jh-a')).toEqual({ status: 'idle', stateChangeSeq: 4, paneId: 'w7:p5' });
    expect(await hopper().getAgent('jh-gone')).toBeNull();
    await expect(hopper().run(['usage'])).rejects.toMatchObject({ code: 'usage' });
    const text = `it's "quoted" $HOME \`date\` ; | &\nsecond line`;
    await hopper().prompt('jh-a', text);
    expect(herdrCalls().at(-1)).toEqual(['--session', 'hopper', 'agent', 'prompt', 'jh-a', text]);
  });

  it('the client refuses a hopper with the wrong token: code client, herdr never runs', async () => {
    await serve();
    const err = await hopper(mintToken()).getAgent('jh-a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrError);
    expect(err).toMatchObject({ code: 'client', message: expect.stringMatching(/refused the hopper \(401\)/) });
    expect(herdrCalls()).toEqual([]);
  });

  it('the hopper cannot make the client run another session: --session in the args is refused', async () => {
    await serve();
    await expect(hopper().exec(['--session', 'default', 'status', 'server'])).rejects.toMatchObject({ code: 'client', message: expect.stringMatching(/400/) });
    expect(herdrCalls()).toEqual([]);
  });

  it('something else on the link that cannot sign as the client: not believed', async () => {
    const impostor = createH2Server((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 0, stdout: 'status: running\n', stderr: '' })); });
    let link: Socket | undefined;
    const end = createServer((s) => { link = s; impostor.emit('connection', s); });
    await new Promise<void>((r) => end.listen(0, '127.0.0.1', r));
    const dialled = connect((end.address() as { port: number }).port, '127.0.0.1');
    try {
      await waitFor(() => link, { what: 'the impostor\'s link' });
      // The hopper's end is the dialled socket's peer; here the impostor answers on it.
      const h = createHerdrCliClient({ client: { machine: 'studio', link: () => dialled, token: () => TOKEN } });
      await expect(h.exec(['status', 'server'])).rejects.toMatchObject({ code: 'client', message: expect.stringMatching(/did not prove itself/) });
    } finally {
      dialled.destroy();
      await new Promise((r) => end.close(r));
    }
  });

  it('not dialled in: code client, not dialled in', async () => {
    const h = createHerdrCliClient({ client: { machine: 'studio', link: () => undefined, token: () => TOKEN } });
    await expect(h.exec(['status', 'server'])).rejects.toMatchObject({ code: 'client', message: expect.stringMatching(/is not dialled in/) });
  });

  it('a link that ends is dialled again; the next call goes down the new one', async () => {
    await serve();
    process.env.FAKE_HERDR_RUNNING = '1';
    await hopper().exec(['status', 'server']);
    const first = client!.link();
    first!.destroy();
    const out = await waitFor(async () => (client!.link() && client!.link() !== first ? hopper().exec(['status', 'server']).catch(() => undefined) : undefined), { timeoutMs: 5000, what: 'the new link' });
    expect(out).toMatch(/status: running/);
  });

  it('a client token too short to be safe: refused before anything is sent', async () => {
    await serve();
    await expect(hopper('short').exec(['status', 'server'])).rejects.toMatchObject({ code: 'client', message: expect.stringMatching(/at least 43/) });
  });
});
