// The cloud link's agent (issue #2039 part 2, docs/design.md "The cloud link's connection"): the instance's end of the
// connection to hopper.io. It connects only while the link record exists (R8), checks hopper.io by TLS and the pin of its
// key, answers the challenge with its hello, then sends the heartbeat and the state snapshot and hands each message it
// takes to `receive`. Over the real instance store; hopper.io is a WebSocket server over TLS on loopback that records
// each frame, or the real cloud/ server behind a TLS front.
//   Scenario: with no link record it connects to nothing; a link connects, an unlink sends `unlinked` and closes (R8, R6)
//   Scenario: with an empty pin list it connects to nothing
//   Scenario: a key that does not match the pin, or a certificate the roots do not hold, is refused before the hello (R4)
//   Scenario: it sends a heartbeat at each interval, and the snapshot only while registered, and only when it changed
//   Scenario: a message from hopper.io goes to `receive`; too many in a minute close the connection (R1, R7)
//   Scenario: an outgoing message that holds a secret, or is over its cap, is dropped and recorded (R4, R7)
//   Scenario: a lost connection is tried again with backoff and jitter: 1 s, doubling, at most 5 minutes
//   Scenario: with real hopper.io, a rotation moves the registration and drops the key before only once the new one connected
//   Scenario: with real hopper.io, a revoke there stops the agent until a rotation; the revoke is recorded (R4, R6)
import { createServer, type Server } from 'node:https';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { CLOUD_LINK_KEY, CLOUD_LINK_PREVIOUS_KEY } from '../../src/domain/cloud-link.ts';
import type { HopperIoState } from '../../src/domain/hopper-io-state.ts';
import type { InstanceStore } from '../../src/domain/store.ts';
import type { NewEvent } from '../../src/domain/types.ts';
import { AGENT_TIMES, createCloudLinkAgent, retryDelay, type CloudLinkAgent, type CloudLinkTarget } from '../../src/http/cloud-link-agent.ts';
import { CLOUD_CONNECTED } from '../../src/http/cloud-link-hello.ts';
import { createCloudLinkMessages } from '../../src/http/cloud-link-messages.ts';
import { createCloudLink, type CloudLink } from '../../src/http/cloud-link.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import type { SystemSecrets } from '../../src/vault/system.ts';
import { provedHello } from '../../cloud/hello.ts';
import { LINK_PATH } from '../../cloud/connections.ts';
import { SESSION_COOKIE } from '../../cloud/server.ts';
import { PUBLIC, setUp, stopAll as stopCloud } from '../cloud/harness.ts';
import { testCertificate, tlsFront, type TestCertificate } from '../support/cloud-tls.ts';
import { installFromBefore, testDatabaseUrl } from '../support/database.ts';
import { systemOf } from '../support/system-secrets.ts';
import { waitFor } from '../support/wait.ts';
import { fixedClock } from '../store/helpers.ts';

const stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  await stopCloud();
});

const FAST = { firstRetryMs: 20, maxRetryMs: 200, heartbeatMs: 60, snapshotMs: 30, settledMs: 1000, helloMs: 2000 };
const ADA = '1001';

/** A snapshot as the source makes it; `waiting` changes it. */
const snapshotOf = (waiting: number, key = 'k'): HopperIoState => ({
  schema: 2, sentAt: new Date().toISOString(), instance: { version: 'abcd1234', channel: 'stable' },
  queue: { waiting, running: 0, locked: 0, gate: 'review' }, attention: { questionsAwaitingOwner: 0, jobsLocked: 0, machinesOffline: 0 },
  machines: [{ key, online: true, lanesInUse: 0, lanes: 2, executors: ['claude'], takesJobs: true }],
});

interface Instance { store: InstanceStore; link: CloudLink; secrets: SystemSecrets; agent: CloudLinkAgent; events: NewEvent[]; state: { waiting: number; extra?: string }; keys: string[] }

function instance(target: CloudLinkTarget, times: Partial<typeof AGENT_TIMES> = FAST): Instance {
  const store = openInstanceStore({ url: installFromBefore(testDatabaseUrl()), clock: fixedClock() });
  const events: NewEvent[] = [];
  const append = (e: NewEvent) => { events.push(e); return e; };
  const secrets = systemOf({ vault: store.vault, events: { append }, tx: store.tx });
  const state = { waiting: 0 } as Instance['state'];
  const keys: string[] = [];
  let agent: CloudLinkAgent | undefined;
  const link = createCloudLink({ settings: store.settings, secrets, events: { append }, now: () => new Date(), changed: (before) => agent?.changed(before), connection: () => agent!.status() });
  agent = createCloudLinkAgent({
    settings: store.settings, cloudLink: link, secrets, messages: createCloudLinkMessages({ cloudLink: link, events: { append } }), events: { append }, now: () => new Date(), target, times,
    state: {
      snapshot: async (machineKey) => {
        const key = machineKey!('admin', 'local');
        keys.push(key);
        const s = snapshotOf(state.waiting, key);
        return (state.extra ? { ...s, instance: { ...s.instance, version: state.extra } } : s) as HopperIoState;
      },
    },
  });
  stops.push(async () => { await agent!.stop(); store.close(); });
  return { store, link, secrets, agent, events, state, keys };
}

/** A WebSocket server over TLS on loopback, as hopper.io: it sends a challenge, checks the hello, answers `connected`. */
async function fakeHopperIo(c: TestCertificate = testCertificate()) {
  const server: Server = createServer({ cert: c.cert, key: c.key });
  const wss = new WebSocketServer({ server, path: LINK_PATH });
  const frames: string[] = [];
  const sockets: WebSocket[] = [];
  let hellos = 0;
  wss.on('connection', (ws) => {
    sockets.push(ws);
    const nonce = 'n'.repeat(43);
    let proved = false;
    ws.on('message', (data) => {
      const text = data.toString();
      if (!proved) {
        proved = provedHello(text, nonce) !== undefined;
        if (!proved) { ws.close(4001); return; }
        hellos++;
        ws.send(CLOUD_CONNECTED);
        return;
      }
      frames.push(text);
    });
    ws.send(JSON.stringify({ type: 'challenge', nonce }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  stops.push(() => new Promise<void>((r) => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(() => r()); }));
  return {
    target: { url: `wss://127.0.0.1:${port}${LINK_PATH}`, pins: [c.pin], ca: c.cert } satisfies CloudLinkTarget,
    frames, hellos: () => hellos, last: () => sockets.at(-1)!, cert: c,
    typed: (type: string) => frames.map((f) => JSON.parse(f) as { type?: string; schema?: number }).filter((f) => (type === 'snapshot' ? f.schema !== undefined : f.type === type)),
  };
}

const types = (i: Instance) => i.events.map((e) => e.type).filter((t) => t.startsWith('cloud_link.'));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the cloud link\'s agent', () => {
  it('with no link record it connects to nothing; a link connects, an unlink sends `unlinked` and closes', async () => {
    const io = await fakeHopperIo();
    const i = instance(io.target);
    i.agent.start();
    await pause(100);
    expect(io.hellos()).toBe(0);
    expect(i.agent.status()).toEqual({ state: 'off' });

    const { link } = i.link.link('ada', 'admin');
    await waitFor(() => i.agent.status().state === 'connected', { what: 'connected' });
    expect(io.hellos()).toBe(1);
    expect(i.link.view().connection).toMatchObject({ state: 'connected', since: expect.any(String) });
    expect(i.events).toContainEqual({ type: 'cloud_link.connected', data: { installId: link!.installId, account: 'ada' } });

    const closed = new Promise<number>((r) => io.last().on('close', (code) => r(code)));
    i.link.unlink('admin');
    expect(await closed).toBe(1000);
    expect(io.typed('unlinked')).toEqual([{ type: 'unlinked', installId: link!.installId, account: 'ada' }]);
    expect(i.agent.status()).toEqual({ state: 'off' });
    await pause(100);
    expect(io.hellos()).toBe(1);
    expect(types(i)).toEqual(['cloud_link.linked', 'cloud_link.connected', 'cloud_link.unlinked', 'cloud_link.disconnected']);
  });

  it('with an empty pin list it connects to nothing', async () => {
    const io = await fakeHopperIo();
    const i = instance({ ...io.target, pins: [] });
    i.link.link('ada', 'admin');
    i.agent.start();
    await pause(100);
    expect(io.hellos()).toBe(0);
    expect(i.agent.status()).toEqual({ state: 'no-pin' });
  });

  it('a key that does not match the pin, or a certificate the roots do not hold, is refused before the hello', async () => {
    const io = await fakeHopperIo();
    const pinned = instance({ ...io.target, pins: [testCertificate().pin] });
    pinned.link.link('ada', 'admin');
    pinned.agent.start();
    await waitFor(() => pinned.events.filter((e) => e.type === 'cloud_link.connection_refused').length > 0 && pinned.agent.status().state === 'waiting');
    await pause(150);
    expect(io.hellos()).toBe(0);
    // Each attempt is refused the same way: one record, not one per attempt.
    expect(pinned.events.filter((e) => e.type === 'cloud_link.connection_refused')).toEqual([
      { type: 'cloud_link.connection_refused', data: expect.objectContaining({ reason: 'pin' }) },
    ]);
    expect(pinned.agent.status()).toMatchObject({ state: 'waiting', retryAt: expect.any(String), problem: expect.stringContaining('pin') });

    const { ca: _ca, ...noRoot } = io.target;
    const unknown = instance(noRoot);
    unknown.link.link('ada', 'admin');
    unknown.agent.start();
    await waitFor(() => unknown.events.some((e) => e.type === 'cloud_link.connection_refused'));
    expect(unknown.events.find((e) => e.type === 'cloud_link.connection_refused')!.data).toMatchObject({ reason: 'tls' });
    expect(io.hellos()).toBe(0);
  });

  it('it sends a heartbeat at each interval, and the snapshot only while registered, and only when it changed', async () => {
    const io = await fakeHopperIo();
    const i = instance(io.target);
    i.link.link('ada', 'admin');
    i.agent.start();
    await waitFor(() => io.typed('heartbeat').length >= 2, { what: 'two heartbeats' });
    expect(io.typed('snapshot')).toEqual([]);

    // Registered: the snapshot goes at once, then again only when it changes.
    const { code } = i.link.mintRegistrationCode('admin');
    io.last().send(JSON.stringify({ type: 'register', code, account: 'ada' }));
    await waitFor(() => io.typed('snapshot').length === 1, { what: 'the first snapshot' });
    expect(io.typed('registration')).toEqual([{ type: 'registration', outcome: 'registered' }]);
    await pause(150);
    expect(io.typed('snapshot')).toHaveLength(1);
    i.state.waiting = 3;
    await waitFor(() => io.typed('snapshot').length === 2, { what: 'the changed snapshot' });
    expect(io.typed('snapshot')[1]).toMatchObject({ queue: { waiting: 3 } });
    // The machine key is opaque and stable: never the machine id.
    expect(new Set(i.keys).size).toBe(1);
    expect(i.keys[0]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(i.keys[0]).not.toContain('local');
  });

  it('a message from hopper.io goes to `receive`; too many in a minute close the connection', async () => {
    const io = await fakeHopperIo();
    const i = instance(io.target, { ...FAST, messagesPerMinute: 5 });
    i.link.link('ada', 'admin');
    i.agent.start();
    await waitFor(() => i.agent.status().state === 'connected');
    io.last().send(JSON.stringify({ type: 'run', command: 'rm -rf /' }));
    await waitFor(() => io.typed('refused').length === 1);
    expect(io.typed('refused')).toEqual([{ type: 'refused', reason: 'unknown-type' }]);
    expect(i.events).toContainEqual({ type: 'cloud_link.message_refused', data: { reason: 'unknown-type' } });

    const closed = new Promise<number>((r) => io.last().on('close', (code) => r(code)));
    for (let n = 0; n < 6; n++) io.last().send(JSON.stringify({ type: 'unregister', account: 'ada' }));
    expect(await closed).toBe(1008);
    expect(i.events).toContainEqual({ type: 'cloud_link.message_refused', data: { reason: 'too-many' } });
  });

  it('an outgoing message that holds a secret, or is over its cap, is dropped and recorded', async () => {
    const io = await fakeHopperIo();
    const i = instance(io.target);
    i.link.link('ada', 'admin');
    i.state.extra = `ghp_${'a1B2'.repeat(9)}`;
    i.link.mintRegistrationCode('admin');
    i.store.settings.setCloudLink({ ...i.store.settings.getCloudLink()!, state: 'registered', registeredAt: new Date().toISOString() });
    i.agent.start();
    await waitFor(() => i.events.some((e) => e.type === 'cloud_link.message_dropped'));
    expect(i.events.find((e) => e.type === 'cloud_link.message_dropped')).toEqual({ type: 'cloud_link.message_dropped', data: { message: 'snapshot', reason: 'secret' } });
    expect(io.frames.join('\n')).not.toContain('ghp_');

    i.state.extra = 'x'.repeat(200 * 1024);
    await waitFor(() => i.events.some((e) => e.type === 'cloud_link.message_dropped' && e.data.reason === 'too-large'));
    expect(io.typed('snapshot')).toEqual([]);
    // The hello holds the public half of the key, which looks like a key, and is not dropped for it.
    expect(io.hellos()).toBe(1);
  });

  it('a lost connection is tried again with backoff and jitter: 1 s, doubling, at most 5 minutes', async () => {
    expect(AGENT_TIMES).toMatchObject({ firstRetryMs: 1000, maxRetryMs: 300_000, heartbeatMs: 30_000, snapshotMs: 2000 });
    expect(retryDelay(0, 0)).toBe(500);
    expect(retryDelay(0, 1)).toBe(1000);
    expect(retryDelay(1, 1)).toBe(2000);
    expect(retryDelay(3, 0.5)).toBe(6000);
    expect(retryDelay(20, 1)).toBe(300_000);
    expect(retryDelay(20, 0)).toBe(150_000);

    const io = await fakeHopperIo();
    const i = instance(io.target);
    i.link.link('ada', 'admin');
    i.agent.start();
    await waitFor(() => io.hellos() === 1);
    io.last().terminate();
    await waitFor(() => io.hellos() === 2, { what: 'the agent connects again' });
    expect(types(i)).toEqual(['cloud_link.linked', 'cloud_link.connected', 'cloud_link.disconnected', 'cloud_link.connected']);
  });
});

describe('the cloud link\'s agent with hopper.io', () => {
  const form = { 'content-type': 'application/x-www-form-urlencoded' };

  async function hopperIo() {
    const s = await setUp();
    await s.store.signedIn({ githubUserId: ADA, login: 'ada' });
    await s.store.openSession('ada-session', ADA, new Date());
    await s.server.listen({ host: '127.0.0.1', port: 0 });
    const front = await tlsFront((s.server.server.address() as { port: number }).port);
    stops.push(() => front.close());
    const cookie = `${SESSION_COOKIE}=ada-session`;
    return {
      s, target: { url: front.url, pins: [front.cert.pin], ca: front.cert.cert } satisfies CloudLinkTarget,
      instances: async () => (await s.server.inject({ method: 'GET', url: '/api/account/instances', headers: { cookie } })).json().instances as Record<string, unknown>[],
      kinds: async () => (await s.store.records(ADA, new Date(Date.now() + 60_000))).map((r) => r.kind).reverse(),
      enter: (installId: string, code: string) => s.server.inject({ method: 'POST', url: '/account/instances/register', headers: { ...form, origin: PUBLIC, cookie }, payload: `installId=${installId}&code=${code}` }),
      remove: (installId: string) => s.server.inject({ method: 'POST', url: `/account/instances/${installId}/remove`, headers: { ...form, origin: PUBLIC, cookie } }),
    };
  }

  async function registered(io: Awaited<ReturnType<typeof hopperIo>>, i: Instance): Promise<string> {
    const installId = i.link.link('ada', 'admin').link!.installId;
    i.agent.start();
    await waitFor(() => i.agent.status().state === 'connected', { what: 'connected' });
    expect((await io.enter(installId, i.link.mintRegistrationCode('admin').code)).statusCode).toBe(303);
    await waitFor(async () => (await io.instances()).length === 1 && i.link.view().link?.state === 'registered', { what: 'registered on both sides' });
    return installId;
  }

  it('a rotation moves the registration and drops the key before only once the new one connected', async () => {
    const io = await hopperIo();
    const i = instance(io.target);
    await registered(io, i);
    const before = i.link.view().link!.linkKey!.publicKey;

    i.link.rotateKey('admin');
    const after = i.link.view().link!.linkKey!.publicKey;
    await waitFor(async () => (await io.kinds()).includes('key_rotated'), { what: 'key_rotated at hopper.io' });
    await waitFor(() => i.link.view().link?.previousKey === undefined, { what: 'the key before dropped' });
    expect(after).not.toBe(before);
    expect(i.secrets.meta(CLOUD_LINK_PREVIOUS_KEY)).toBeUndefined();
    expect(i.secrets.meta(CLOUD_LINK_KEY)).toBeDefined();
    expect(await io.instances()).toEqual([expect.objectContaining({ connected: true })]);
  });

  it('a revoke there stops the agent until a rotation; the revoke is recorded', async () => {
    const io = await hopperIo();
    const i = instance(io.target);
    const installId = await registered(io, i);
    expect((await io.remove(installId)).statusCode).toBe(303);
    await waitFor(() => i.agent.status().state === 'revoked', { what: 'revoked' });
    expect(i.link.view().link).toMatchObject({ state: 'pending' });
    expect(i.events).toContainEqual({ type: 'cloud_link.revoked', data: { installId, account: 'ada', by: 'hopper.io' } });
    await pause(150);
    expect((await io.kinds()).filter((k) => k === 'connection_refused')).toEqual([]);
    expect(types(i).filter((t) => t === 'cloud_link.connected')).toHaveLength(1);

    i.link.rotateKey('admin');
    await waitFor(() => i.agent.status().state === 'connected', { what: 'connected with the new key' });
    expect((await io.enter(installId, i.link.mintRegistrationCode('admin').code)).statusCode).toBe(303);
    await waitFor(async () => (await io.instances()).length === 1, { what: 'registered again' });
  });
});
