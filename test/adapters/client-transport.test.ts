// The herdr CLI client on a client target (issue #59, design.md "Client targets"): every herdr call
// goes over HTTP/2 to the hopper client, through the socket its tunnel's relay opens here, signed with
// the client's token; an answer the client did not sign is not believed. The client is real; its
// tunnel is the real relay, run directly instead of as ssh's forced command. herdr is the stand-in.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer as createH2Server, type Http2Server } from 'node:http2';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '../../src/client/server.ts';
import { mintToken } from '../../src/client/signature.ts';
import { clientSocket } from '../../src/executors/client.ts';
import { HerdrError, createHerdrCliClient } from '../../src/executors/herdr/index.ts';
import { RELAY, startTestClient } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const TOKEN = mintToken();

let dir: string;
let client: Client | undefined;
const saved = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync('/tmp/jh-ct-');
  chmodSync(dir, 0o700);
  mkdirSync(join(dir, 'clients'), { mode: 0o700 });
  process.env.FAKE_HERDR_DIR = dir;
});
afterEach(async () => {
  await client?.stop();
  client = undefined;
  process.env = { ...saved };
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const machine = () => `studio${n}`;
const sock = () => clientSocket(dir, machine());
const hopper = (token = TOKEN) => createHerdrCliClient({ client: { machine: machine(), socket: sock(), token: () => token } });
const serve = async (token = TOKEN) => { n++; client = await startTestClient(sock(), { token: () => token, herdrBin: HERDR, session: 'hopper' }); };
const herdrCalls = (): string[][] => (existsSync(join(dir, 'calls.jsonl'))
  ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { argv: string[] }).argv) : []);

describe('herdr over a client target', () => {
  it('the tunnel\'s socket for a machine is <dataDir>/clients/<name>.sock, only this user may open it', async () => {
    expect(clientSocket('/d', 'studio')).toBe('/d/clients/studio.sock');
    expect(() => clientSocket('/d', '../x')).toThrow(/bad client target name/);
    await serve();
    expect(statSync(sock()).mode & 0o777).toBe(0o600);
  });

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

  it('something else at the tunnel\'s socket that cannot sign as the client: not believed', async () => {
    n++;
    const impostor: Http2Server = createH2Server((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 0, stdout: 'status: running\n', stderr: '' })); });
    await new Promise<void>((r) => impostor.listen(sock(), r));
    try {
      await expect(hopper().exec(['status', 'server'])).rejects.toMatchObject({ code: 'client', message: expect.stringMatching(/did not prove itself/) });
    } finally {
      await new Promise((r) => impostor.close(r));
    }
  });

  it('no tunnel: code client, not connected', async () => {
    n++;
    await expect(hopper().exec(['status', 'server'])).rejects.toMatchObject({ code: 'client', message: expect.stringMatching(/is not connected/) });
  });

  it('the relay takes one connection: nothing else on this machine can reach the client through the tunnel', async () => {
    await serve();
    await hopper().exec(['status', 'server']);
    expect(existsSync(sock())).toBe(false);
  });

  it('a tunnel that ends is dialed again; the next call reaches the client', async () => {
    await serve();
    process.env.FAKE_HERDR_RUNNING = '1';
    await hopper().exec(['status', 'server']);
    // The tunnel drops (its relay dies): the client dials again, the next call goes through the new one.
    spawnSync('pkill', ['-f', `relay.ts ${sock()}`]);
    const out = await waitFor(async () => hopper().exec(['status', 'server']).catch(() => undefined), { timeoutMs: 5000, what: 'the tunnel again' });
    expect(out).toMatch(/status: running/);
  });

  it('a socket left by a relay that died is replaced by the next relay', async () => {
    n++;
    const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(sock())}, () => console.log('up'))`]);
    await new Promise((r) => child.stdout.once('data', r));
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    expect(existsSync(sock())).toBe(true);
    client = await startTestClient(sock(), { token: () => TOKEN, herdrBin: HERDR, session: 'hopper' });
    process.env.FAKE_HERDR_RUNNING = '1';
    const out = await waitFor(async () => hopper().exec(['status', 'server']).catch(() => undefined), { timeoutMs: 5000, what: 'the new relay' });
    expect(out).toMatch(/status: running/);
  });

  it('a client token too short to be safe: refused before connecting', async () => {
    await serve();
    await expect(hopper('short').exec(['status', 'server'])).rejects.toMatchObject({ code: 'client', message: expect.stringMatching(/at least 43/) });
  });

  it('relay usage: an absolute .sock path only', async () => {
    const r = spawn(process.execPath, [RELAY, 'relative.sock']);
    expect(await new Promise((res) => r.once('exit', res))).toBe(2);
  });
});
