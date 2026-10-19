// The cloud link's connection at hopper.io (issue #2039, docs/design.md "The cloud link's connection"): an instance opens
// one WebSocket, answers hopper.io's challenge with its hello (the instance's own, src/http/cloud-link-hello.ts), and then
// each text frame is one message. Real Postgres, the real server listening on loopback, a real WebSocket client (ws).
//   Scenario: an instance connects; a code its owner enters reaches it as `register`, and its answer registers it with its key
//   Scenario: a registered instance connects only with its key, or with a new key its hello proves by the old one (R4, T2)
//   Scenario: a removal at hopper.io sends `unregister` and revokes the key: it connects no more, a new key does (R4)
//   Scenario: a second connection of the instance replaces the first, and each is recorded (R6, T2)
//   Scenario: a heartbeat keeps the last-seen time; a snapshot is kept; the unlink notice removes the registration
//   Scenario: a bad hello, a message over a cap or of another type is refused and recorded once (R7)
//   Scenario: too many connections of one instance in a minute are refused (R7)
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CLOSE, LIMITS, LINK_PATH } from '../../cloud/connections.ts';
import { SNAPSHOT_MAX_BYTES } from '../../cloud/states.ts';
import { SESSION_COOKIE } from '../../cloud/server.ts';
import { challengeNonce, heartbeatMessage, helloMessage } from '../../src/http/cloud-link-hello.ts';
import { unlinkedMessage } from '../../src/http/cloud-link-messages.ts';
import { PUBLIC, rows, setUp, stopAll, type Set } from './harness.ts';

afterEach(stopAll);

const ADA = '1001';
const INSTANCE = '7f0c2a4e1d1b4c55';
const CODE = 'c0de'.repeat(16);
const form = { 'content-type': 'application/x-www-form-urlencoded' };

interface Key { secret: string; publicKey: string }
function key(): Key {
  const { privateKey } = generateKeyPairSync('ed25519');
  const { d, x } = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
  return { secret: JSON.stringify({ d, x, crv: 'Ed25519', kty: 'OKP' }), publicKey: x };
}

/** An instance's end of the link: the messages hopper.io sent it after the challenge, and how the connection closed. */
interface End { ws: WebSocket; next(): Promise<string>; closed: Promise<number>; send(text: string): void }

/** Opens the link at `url` and answers the challenge with `hello` (made from the nonce); default the instance's own hello. */
function connect(url: string, k: Key, o: { account?: string; previous?: Key; hello?: (nonce: string) => string } = {}): Promise<End> {
  const ws = new WebSocket(url);
  const queue: string[] = [];
  const waiting: ((t: string) => void)[] = [];
  let challenged = false;
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('message', (data) => {
      const text = data.toString();
      if (!challenged) {
        challenged = true;
        const nonce = challengeNonce(text)!;
        ws.send(o.hello ? o.hello(nonce) : helloMessage({ link: { installId: INSTANCE, account: o.account ?? 'ada' }, nonce, ...k, ...(o.previous ? { previous: o.previous } : {}) }));
        resolve({ ws, closed, send: (t) => ws.send(t), next: () => new Promise((r) => { const t = queue.shift(); if (t !== undefined) r(t); else waiting.push(r); }) });
        return;
      }
      const w = waiting.shift();
      if (w) w(text); else queue.push(text);
    });
  });
}

async function listening(s: Set): Promise<string> {
  await s.store.signedIn({ githubUserId: ADA, login: 'ada' });
  await s.store.openSession('ada-session', ADA, new Date());
  await s.server.listen({ host: '127.0.0.1', port: 0 });
  const { port } = s.server.server.address() as { port: number };
  return `ws://127.0.0.1:${port}${LINK_PATH}`;
}
const instances = async (s: Set) => (await s.server.inject({ method: 'GET', url: '/api/account/instances', headers: { cookie: `${SESSION_COOKIE}=ada-session` } })).json().instances as Record<string, unknown>[];
const kinds = async (s: Set) => (await s.store.records(ADA, new Date(Date.now() + 60_000))).map((r) => r.kind).reverse();
const enterCode = (s: Set) => s.server.inject({ method: 'POST', url: '/account/instances/register', headers: { ...form, origin: PUBLIC, cookie: `${SESSION_COOKIE}=ada-session` }, payload: `installId=${INSTANCE}&code=${CODE}` });
const registered = JSON.stringify({ type: 'registration', outcome: 'registered' });
/** Until `f` holds, or a second. */
async function until(f: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 100 && !await f(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(await f()).toBe(true);
}

/** An instance registered to ADA with `k`, connected: its end. */
async function registeredInstance(s: Set, url: string, k: Key): Promise<End> {
  const end = await connect(url, k);
  expect((await enterCode(s)).statusCode).toBe(303);
  expect(JSON.parse(await end.next())).toEqual({ type: 'register', code: CODE, account: 'ada' });
  end.send(registered);
  await until(async () => (await instances(s)).length === 1);
  return end;
}

describe("the cloud link's connection at hopper.io", () => {
  it('an instance connects; a code its owner enters reaches it as `register`, and its answer registers it with its key', async () => {
    const s = await setUp();
    const url = await listening(s);
    const k = key();
    await registeredInstance(s, url, k);
    expect(await instances(s)).toEqual([expect.objectContaining({ installId: INSTANCE, connected: true })]);
    const all = JSON.parse(await rows(s.databaseUrl)) as { r: Record<string, unknown> }[][];
    expect(all[4]![0]!.r).toMatchObject({ install_id: INSTANCE, public_key: k.publicKey });
    expect(await kinds(s)).toEqual(['instance_registered']);
    const page = (await s.server.inject({ method: 'GET', url: '/', headers: { cookie: `${SESSION_COOKIE}=ada-session` } })).body;
    expect(page).toContain('connected now');

    // A code entered before the instance connects reaches it right after its hello.
    const s2 = await setUp();
    const url2 = await listening(s2);
    expect((await enterCode(s2)).statusCode).toBe(303);
    const end = await connect(url2, key());
    expect(JSON.parse(await end.next())).toEqual({ type: 'register', code: CODE, account: 'ada' });
  });

  it('a registered instance connects only with its key, or with a new key its hello proves by the old one', async () => {
    const s = await setUp();
    const url = await listening(s);
    const k = key();
    const first = await registeredInstance(s, url, k);
    first.ws.close();
    await until(async () => (await instances(s))[0]!.connected === false);

    const thief = await connect(url, key());
    expect(await thief.closed).toBe(CLOSE.unknownKey);
    const forged = await connect(url, key(), { previous: key() });
    expect(await forged.closed).toBe(CLOSE.unknownKey);

    const rotated = key();
    const moved = await connect(url, rotated, { previous: k });
    await until(async () => (await instances(s))[0]!.connected === true);
    const all = JSON.parse(await rows(s.databaseUrl)) as { r: Record<string, unknown> }[][];
    expect(all[4]![0]!.r.public_key).toBe(rotated.publicKey);
    moved.ws.close();
    expect(await moved.closed).toBe(1005);
    const old = await connect(url, k);
    expect(await old.closed).toBe(CLOSE.unknownKey);
    await until(async () => (await kinds(s)).includes('key_rotated'));
    expect((await kinds(s)).filter((x) => x === 'connection_refused')).toHaveLength(3);
  });

  it('a removal at hopper.io sends `unregister` and revokes the key: it connects no more, a new key does', async () => {
    const s = await setUp();
    const url = await listening(s);
    const k = key();
    const end = await registeredInstance(s, url, k);
    const removed = await s.server.inject({ method: 'POST', url: `/account/instances/${INSTANCE}/remove`, headers: { ...form, origin: PUBLIC, cookie: `${SESSION_COOKIE}=ada-session` } });
    expect(removed.statusCode).toBe(303);
    expect(JSON.parse(await end.next())).toEqual({ type: 'unregister', account: 'ada' });
    expect(await end.closed).toBe(CLOSE.revoked);

    const again = await connect(url, k);
    expect(JSON.parse(await again.next())).toEqual({ type: 'unregister', account: 'ada' });
    expect(await again.closed).toBe(CLOSE.revoked);

    const fresh = await connect(url, key(), { previous: k });
    expect(JSON.parse(await fresh.next())).toEqual({ type: 'unregister', account: 'ada' });
    fresh.send(JSON.stringify({ type: 'unregistration', outcome: 'unregistered' }));
    expect((await enterCode(s)).statusCode).toBe(303);
    expect(JSON.parse(await fresh.next())).toMatchObject({ type: 'register' });
  });

  it('a second connection of the instance replaces the first, and each is recorded', async () => {
    const s = await setUp();
    const url = await listening(s);
    const k = key();
    const first = await registeredInstance(s, url, k);
    const second = await connect(url, k);
    expect(await first.closed).toBe(CLOSE.replaced);
    await until(async () => (await kinds(s)).includes('connection_replaced'));
    expect((await instances(s))[0]!.connected).toBe(true);
    second.ws.close();
    await until(async () => (await kinds(s)).at(-1) === 'instance_disconnected');
    expect(await kinds(s)).toEqual(['instance_registered', 'connection_replaced', 'instance_connected', 'instance_disconnected']);
    expect((await instances(s))[0]!.connected).toBe(false);
  });

  it('a heartbeat keeps the last-seen time; a snapshot is kept; the unlink notice removes the registration', async () => {
    const s = await setUp();
    const url = await listening(s);
    const end = await registeredInstance(s, url, key());
    const seen = (await instances(s))[0]!.seenAt;
    await new Promise((r) => setTimeout(r, 20));
    end.send(heartbeatMessage(new Date()));
    await until(async () => (await instances(s))[0]!.seenAt !== seen);
    end.send(JSON.stringify({
      schema: 2, sentAt: new Date().toISOString(), instance: { version: 'abcd1234', channel: 'stable' },
      queue: { waiting: 1, running: 0, locked: 0, gate: 'review' }, attention: { questionsAwaitingOwner: 0, jobsLocked: 0, machinesOffline: 0 },
      machines: [{ key: 'm1', online: true, lanesInUse: 0, lanes: 2, executors: ['claude'], takesJobs: true }],
    }));
    await until(async () => (await instances(s))[0]!.state !== undefined);
    end.send(unlinkedMessage({ installId: INSTANCE, account: 'ada' }));
    await until(async () => (await instances(s)).length === 0);
    end.ws.close();
    await end.closed;
    expect(await kinds(s)).toEqual(['instance_registered', 'instance_unlinked']);
  });

  it('a bad hello, a message over a cap or of another type is refused and recorded once', async () => {
    const s = await setUp();
    const url = await listening(s);
    const k = key();
    const bad = await connect(url, k, { hello: (nonce) => helloMessage({ link: { installId: INSTANCE, account: 'ada' }, nonce: `${nonce.slice(1)}A`, ...k }) });
    expect(await bad.closed).toBe(CLOSE.badHello);
    const binary = new WebSocket(url);
    binary.on('message', () => binary.send(Buffer.from('hello')));
    expect(await new Promise((r) => binary.on('close', r))).toBe(CLOSE.badHello);

    const end = await registeredInstance(s, url, k);
    end.send(JSON.stringify({ type: 'run', command: 'rm -rf /' }));
    end.send(JSON.stringify({ type: 'heartbeat', sentAt: new Date().toISOString(), note: 'x'.repeat(2000) }));
    end.send(Buffer.from('binary') as unknown as string);
    await until(async () => (await kinds(s)).includes('message_refused'));
    end.ws.send('x'.repeat(SNAPSHOT_MAX_BYTES + 1));
    expect(await end.closed).toBe(1009);
    await until(async () => (await kinds(s)).at(-1) === 'instance_disconnected');
    expect((await kinds(s)).filter((x) => x === 'message_refused')).toHaveLength(1);
    expect(await instances(s)).toHaveLength(1);
  });

  it('too many connections of one instance in a minute are refused', async () => {
    const s = await setUp();
    const url = await listening(s);
    const k = key();
    for (let i = 0; i < LIMITS.connectsPerInstance; i++) {
      const end = await connect(url, k);
      end.ws.close();
      await end.closed;
    }
    const over = await connect(url, k);
    expect(await over.closed).toBe(CLOSE.tooMany);
  });
});
