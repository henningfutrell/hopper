// The cloud link's agent (issue #2039 part 2, docs/design.md "The cloud link's connection"): the instance's end of its one
// WebSocket to hopper.io, opened by the instance (ws, an established library), only while the link record exists (R8).
// It checks hopper.io by TLS with the system's roots and a pin of hopper.io's public key shipped in this code (HOPPER_IO):
// a key that does not match is refused before the hello, and with no pin it connects to nothing. It answers hopper.io's
// challenge with the hello (cloud-link-hello.ts), which proves the cloud link key, and the key before a rotation until the
// new key connected. Once hopper.io answers `connected` it sends a heartbeat each 30 s and, while registered, the state
// snapshot when it changed, at most each 2 s; it hands each message it takes to `receive` (cloud-link-messages.ts) and
// sends the answer back, and before an unlink closes the connection it sends `unlinked`. Each outgoing message passes the
// secret scan (cloud-link-scan.ts) and its cap, or is dropped (R4, R7); incoming messages are capped by size and rate (R7).
// A lost or refused connection is tried again with backoff and jitter (1 s, doubling, at most 5 minutes); one hopper.io
// closes as revoked is not, until the key changes. Each connect, disconnect, refused connection, revoke, and refused or
// dropped message is an instance event (R6). Its state is kept in memory only, for Settings → hopper.io.
import { createHash, createHmac, X509Certificate } from 'node:crypto';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import WebSocket from 'ws';
import { CLOUD_LINK_KEY, CLOUD_LINK_PREVIOUS_KEY, type CloudConnectionView, type CloudLinkSettings, type CloudOutgoing, type CloudRefusal } from '../domain/cloud-link.ts';
import type { InstanceEvents, InstanceSettingsRepository } from '../domain/ports.ts';
import type { SystemSecrets } from '../vault/system.ts';
import type { CloudLink } from './cloud-link.ts';
import { challengeNonce, CLOUD_CONNECTED, heartbeatMessage, helloMessage } from './cloud-link-hello.ts';
import { CLOUD_MESSAGE_MAX_BYTES, unlinkedMessage, type CloudLinkMessages } from './cloud-link-messages.ts';
import { outgoingSecret } from './cloud-link-scan.ts';
import type { HopperIoStateSource } from './hopper-io-state.ts';

/**
 * Where hopper.io is, and the pins of its public key (base64 SHA-256 of the key's SPKI), shipped in the code: a key a person
 * can change is a key a person can be tricked into changing. `ca`: a root added to the system's, for tests only.
 */
export interface CloudLinkTarget { url: string; pins: readonly string[]; ca?: string }
/** hopper.io as this build knows it. No pin until issue #469 decision 7 says who runs hopper.io: no instance connects. */
export const HOPPER_IO: CloudLinkTarget = { url: 'wss://hopper.io/link', pins: [] };
/** The snapshot's cap per message, as hopper.io's (cloud/states.ts). */
export const CLOUD_SNAPSHOT_MAX_BYTES = 192 * 1024;
/** A frame from hopper.io over this closes the connection; a message over 1024 bytes under it is refused by `receive`. */
const INCOMING_MAX_BYTES = 64 * 1024;
/** The agent's pace: backoff, heartbeat, snapshot, how long a connection must last before the backoff starts again, the
 * TLS and WebSocket handshake's limit, and how many messages from hopper.io a minute it takes. */
export const AGENT_TIMES = { firstRetryMs: 1000, maxRetryMs: 300_000, heartbeatMs: 30_000, snapshotMs: 2000, settledMs: 60_000, helloMs: 15_000, messagesPerMinute: 120 };
/** hopper.io's close codes that refuse a connection (cloud/connections.ts CLOSE), and the one that revokes the key. */
const REFUSED_BY: Record<number, CloudRefusal> = { 4001: 'bad-hello', 4004: 'unknown-key', 4008: 'too-many', 4009: 'hello-timeout' };
const REVOKED = 4003;

/** The pin of a public key: the base64 SHA-256 of its SPKI (DER), as HTTP public key pinning wrote it. */
export const pinOf = (spki: Buffer): string => createHash('sha256').update(spki).digest('base64');

/** The SPKI (DER) of a peer's certificate: `pubkey` is the bare key, not its SPKI. */
const spkiOf = (cert: PeerCertificate): Buffer => new X509Certificate(cert.raw).publicKey.export({ type: 'spki', format: 'der' });

/** How long to wait before try `attempt` (0 first): 1 s doubling, at most 5 minutes, half of it jitter (`random` in [0, 1]). */
export function retryDelay(attempt: number, random: number, t: Pick<typeof AGENT_TIMES, 'firstRetryMs' | 'maxRetryMs'> = AGENT_TIMES): number {
  const d = Math.min(t.maxRetryMs, t.firstRetryMs * 2 ** Math.min(attempt, 30));
  return Math.round(d / 2 + (random * d) / 2);
}

export interface CloudLinkAgent {
  /** Connects when the link record exists. */
  start(): void;
  /** Closes the connection; nothing is tried again. */
  stop(): Promise<void>;
  /** The admin changed the link (`before`: the record before): an unlink sends `unlinked` and closes; a new key reconnects. */
  changed(before: CloudLinkSettings | undefined): void;
  status(): CloudConnectionView;
}

interface Key { publicKey: string; secret: string; d: string }
interface Connection {
  ws: WebSocket; link: CloudLinkSettings; key: Key; previous?: Key;
  helloSent: boolean; connectedAt?: number; ended: boolean; refusal?: CloudRefusal; problem?: string;
  timers: NodeJS.Timeout[]; lastSnapshot?: string; ticking: boolean; received: number[];
}

export function createCloudLinkAgent(o: {
  settings: Pick<InstanceSettingsRepository, 'getCloudLink'>;
  cloudLink: Pick<CloudLink, 'ensureKey' | 'keyConnected'>;
  secrets: Pick<SystemSecrets, 'open'>;
  messages: CloudLinkMessages;
  state: HopperIoStateSource;
  events: Pick<InstanceEvents, 'append'>;
  now: () => Date;
  target?: CloudLinkTarget;
  times?: Partial<typeof AGENT_TIMES>;
  random?: () => number;
}): CloudLinkAgent {
  const target = o.target ?? HOPPER_IO;
  const t = { ...AGENT_TIMES, ...o.times };
  const random = o.random ?? Math.random;
  let status: CloudConnectionView = { state: 'off' };
  let conn: Connection | undefined;
  let retry: NodeJS.Timeout | undefined;
  let attempt = 0;
  let stopped = false;
  let started = false;
  /** The key hopper.io revoked: not tried again until the link's key is another. */
  let revokedKey: string | undefined;
  /** The refusal recorded last, so a refusal that repeats is recorded once. */
  let lastRefusal: CloudRefusal | undefined;

  const ids = (l: Pick<CloudLinkSettings, 'installId' | 'account'>) => ({ installId: l.installId, account: l.account });
  const iso = (ms = o.now().getTime()) => new Date(ms).toISOString();
  const clearRetry = () => { if (retry) clearTimeout(retry); retry = undefined; };
  const keyOf = (name: typeof CLOUD_LINK_KEY | typeof CLOUD_LINK_PREVIOUS_KEY, publicKey: string): Key | undefined => {
    const secret = o.secrets.open(name, 'the cloud link hello');
    return secret === undefined ? undefined : { publicKey, secret, d: (JSON.parse(secret) as { d: string }).d };
  };
  /** The opaque, stable key a machine goes out as (R5): an HMAC under the cloud link key, never the machine's id. */
  const machineKeyOf = (k: Key) => (userId: string, machineId: string) =>
    createHmac('sha256', Buffer.from(k.d, 'base64url')).update(`hopper.io machine key\n${userId}\n${machineId}`).digest('base64url').slice(0, 22);

  /** Sends one message, after its cap and the secret scan; a message that fails either is dropped and recorded. */
  const send = (c: Connection, message: CloudOutgoing, text: string): boolean => {
    const cap = message === 'snapshot' ? CLOUD_SNAPSHOT_MAX_BYTES : CLOUD_MESSAGE_MAX_BYTES;
    const keys = c.previous ? [c.key, c.previous] : [c.key];
    const reason = Buffer.byteLength(text) > cap ? 'too-large' as const
      : outgoingSecret(text, { publicKeys: keys.map((k) => k.publicKey), held: keys.flatMap((k) => [k.d, k.secret]) }) ? 'secret' as const : undefined;
    if (reason) {
      o.events.append({ type: 'cloud_link.message_dropped', data: { message, reason } });
      return false;
    }
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(text);
    return true;
  };

  const snapshot = async (c: Connection) => {
    if (c.ticking || c.ended || c.connectedAt === undefined) return;
    // Only while registered: an instance hopper.io keeps no state for gives it none (R5).
    if (o.settings.getCloudLink()?.state !== 'registered') { delete c.lastSnapshot; return; }
    c.ticking = true;
    try {
      const s = await o.state.snapshot(machineKeyOf(c.key));
      const { sentAt: _sentAt, ...rest } = s;
      const same = JSON.stringify(rest);
      if (same === c.lastSnapshot || c.ended) return;
      c.lastSnapshot = same;
      send(c, 'snapshot', JSON.stringify(s));
    } catch {
      // A snapshot that cannot be made now is made at the next tick.
    } finally {
      c.ticking = false;
    }
  };

  const connected = (c: Connection) => {
    c.connectedAt = o.now().getTime();
    lastRefusal = undefined;
    o.events.append({ type: 'cloud_link.connected', data: ids(c.link) });
    status = { state: 'connected', since: iso(c.connectedAt) };
    // hopper.io took the new key: the key before has done its work.
    if (c.previous) o.cloudLink.keyConnected(c.key.publicKey);
    c.timers.push(setInterval(() => send(c, 'heartbeat', heartbeatMessage(o.now())), t.heartbeatMs));
    c.timers.push(setInterval(() => void snapshot(c), t.snapshotMs));
    void snapshot(c);
  };

  const message = (c: Connection, data: WebSocket.RawData, binary: boolean) => {
    const at = o.now().getTime();
    c.received = c.received.filter((r) => r > at - 60_000);
    c.received.push(at);
    if (c.received.length > t.messagesPerMinute) {
      o.events.append({ type: 'cloud_link.message_refused', data: { reason: 'too-many' } });
      c.problem = 'hopper.io sent too many messages';
      c.ws.close(1008, 'too many messages');
      return;
    }
    const text = binary ? '' : data.toString();
    if (!c.helloSent) {
      const nonce = challengeNonce(text);
      if (!nonce) { c.problem = 'hopper.io sent no challenge'; c.ws.close(1002, 'no challenge'); return; }
      c.helloSent = true;
      const hello = helloMessage({ link: c.link, nonce, publicKey: c.key.publicKey, secret: c.key.secret, ...(c.previous ? { previous: c.previous } : {}) });
      if (!send(c, 'hello', hello)) c.ws.close(1000, 'no hello');
      return;
    }
    if (c.connectedAt === undefined && text === CLOUD_CONNECTED) { connected(c); return; }
    const answer = o.messages.receive(text);
    send(c, (JSON.parse(answer) as { type: CloudOutgoing }).type, answer);
  };

  /** What went wrong on a connection that was not taken: a refusal, or why it could not reach hopper.io. */
  const failed = (c: Connection, e: Error & { code?: string }) => {
    if (c.refusal) return;
    const status = /Unexpected server response: (\d+)/.exec(e.message)?.[1];
    if (status) {
      c.refusal = status === '429' ? 'too-many' : 'http';
      c.problem = `hopper.io answered HTTP ${status}`;
    } else if (/CERT|SELF_SIGNED|SIGNATURE|ERR_TLS|ERR_SSL/.test(e.code ?? '')) {
      c.refusal = 'tls';
      c.problem = `hopper.io's certificate is not good: ${e.code}`;
    } else {
      c.problem ??= `hopper.io cannot be reached: ${e.code ?? e.message}`;
    }
  };

  const closed = (c: Connection, code: number) => {
    for (const timer of c.timers) clearInterval(timer);
    const purposeful = c.ended;
    c.ended = true;
    if (conn === c) conn = undefined;
    if (c.connectedAt !== undefined) o.events.append({ type: 'cloud_link.disconnected', data: { ...ids(c.link), code } });
    else if (REFUSED_BY[code]) { c.refusal = REFUSED_BY[code]; c.problem = `hopper.io refused the connection: ${REFUSED_BY[code]}`; }
    if (purposeful || stopped) return;
    if (code === REVOKED) {
      revokedKey = c.key.publicKey;
      o.events.append({ type: 'cloud_link.revoked', data: { ...ids(c.link), by: 'hopper.io' } });
      status = { state: 'revoked', since: iso() };
      return;
    }
    if (c.refusal && c.refusal !== lastRefusal) o.events.append({ type: 'cloud_link.connection_refused', data: { ...ids(c.link), reason: c.refusal } });
    if (c.refusal) lastRefusal = c.refusal;
    if (c.connectedAt !== undefined && o.now().getTime() - c.connectedAt >= t.settledMs) attempt = 0;
    const delay = retryDelay(attempt++, random(), t);
    status = { state: 'waiting', retryAt: iso(o.now().getTime() + delay), problem: c.problem ?? (c.connectedAt !== undefined ? `the connection ended (code ${code})` : 'hopper.io closed the connection') };
    retry = setTimeout(connect, delay);
  };

  function connect(): void {
    retry = undefined;
    if (stopped) return;
    let link: CloudLinkSettings | undefined;
    let key: Key | undefined;
    let previous: Key | undefined;
    try {
      link = o.cloudLink.ensureKey();
      if (link?.linkKey) key = keyOf(CLOUD_LINK_KEY, link.linkKey.publicKey);
      if (link?.previousKey) previous = keyOf(CLOUD_LINK_PREVIOUS_KEY, link.previousKey.publicKey);
    } catch (e) {
      status = { state: 'no-key', problem: `the cloud link key cannot be read: ${(e as Error).message}` };
      return;
    }
    if (!link) { status = { state: 'off' }; return; }
    if (!key) { status = link.keyRevokedAt ? { state: 'no-key', since: link.keyRevokedAt } : { state: 'no-key' }; return; }
    if (key.publicKey === revokedKey) { status = { state: 'revoked', since: iso() }; return; }
    status = { state: 'connecting' };
    const ws = new WebSocket(target.url, {
      ...(target.ca ? { ca: target.ca } : {}), maxPayload: INCOMING_MAX_BYTES, handshakeTimeout: t.helloMs, perMessageDeflate: false, followRedirects: false,
      // TLS checked the chain against the roots; the pin checks the key is hopper.io's own (ws passes this to tls.connect).
      checkServerIdentity: ((host: string, cert: PeerCertificate) => {
        const bad = checkServerIdentity(host, cert);
        if (bad) return bad;
        if (target.pins.includes(pinOf(spkiOf(cert)))) return undefined;
        c.refusal = 'pin';
        c.problem = 'the key of hopper.io does not match the pin in this version of the hopper';
        return new Error(c.problem);
      }) as unknown as () => boolean,
    });
    const c: Connection = { ws, link, key, ...(previous ? { previous } : {}), helloSent: false, ended: false, timers: [], ticking: false, received: [] };
    conn = c;
    ws.on('message', (data, binary) => message(c, data, binary));
    ws.on('error', (e) => failed(c, e));
    ws.on('close', (code) => closed(c, code));
  }

  /** Closes the connection on purpose: the link changed, or the hopper stops. */
  const close = (code: number, why: string): Connection | undefined => {
    const c = conn;
    if (!c) return undefined;
    conn = undefined;
    c.ended = true;
    for (const timer of c.timers) clearInterval(timer);
    if (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING) c.ws.close(code, why);
    return c;
  };

  /** Connects, keeps, or closes the connection for the link record now. */
  const sync = () => {
    if (stopped || !started) return;
    const link = o.settings.getCloudLink();
    if (!link) { close(1000, 'unlinked'); clearRetry(); status = { state: 'off' }; return; }
    if (target.pins.length === 0) { status = { state: 'no-pin' }; return; }
    if (conn && conn.link.installId === link.installId && conn.link.account === link.account && conn.key.publicKey === link.linkKey?.publicKey) return;
    close(1000, 'the link changed');
    clearRetry();
    attempt = 0;
    connect();
  };

  return {
    start() { started = true; sync(); },
    async stop() {
      stopped = true;
      clearRetry();
      const c = close(1001, 'the hopper stops');
      if (!c || c.ws.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { c.ws.terminate(); resolve(); }, 2000);
        c.ws.once('close', () => { clearTimeout(timer); resolve(); });
      });
    },
    changed(before) {
      if (before && !o.settings.getCloudLink() && conn?.connectedAt !== undefined) send(conn, 'unlinked', unlinkedMessage(before));
      sync();
    },
    status: () => status,
  };
}
