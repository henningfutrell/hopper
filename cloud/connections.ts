// hopper.io's end of the cloud link's connection (issue #2039, docs/design.md "The cloud link's connection"): one
// WebSocket per instance, which the instance opens at LINK_PATH (ws, an established library). hopper.io sends a challenge
// first; the instance's first message is its hello (cloud/hello.ts), which proves its cloud link key; a hello it takes is
// answered `connected` (part 2), a hello it refuses is closed with a code that says why. Then each text frame
// is one message, handed to the transport-free answers (cloud/link.ts): `registration`, `unlinked`, the state snapshot,
// and the heartbeat, which keeps its last-seen time. hopper.io sends only `register` and `unregister` (R1).
// Limits (R7): the snapshot's cap per frame (the ws server refuses a larger one), 1024 bytes for any other message, a rate
// of connections per address and per instance, of messages per connection, and of open connections in all. A message
// that is refused is dropped, not cut, and recorded once per connection. A second connection of the same instance
// replaces the first. Which instances are connected now is kept in memory only; their records go to the account (R6).
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { challenge, CONNECTED, HEARTBEAT_SCHEMA, provedHello, type ProvedHello } from './hello.ts';
import { LINK_MESSAGE_MAX_BYTES, type CloudLinkAnswers } from './link.ts';
import { SNAPSHOT_MAX_BYTES } from './states.ts';
import type { CloudStore, RecordKind } from './store.ts';

/** Where an instance opens its cloud link. */
export const LINK_PATH = '/link';
/** How hopper.io closes a connection, and why: the instance's agent tells a revoked key from a lost connection by it. */
export const CLOSE = {
  replaced: 4000, badHello: 4001, revoked: 4003, unknownKey: 4004, tooMany: 4008, helloTimeout: 4009, idle: 4010, closing: 1001,
} as const;
/** How long hopper.io waits for the hello after its challenge. */
export const HELLO_MS = 10_000;
/** How long a connection may stay silent: three heartbeats (the instance sends one each 30 s). */
export const IDLE_MS = 90_000;
/** Limits per minute (R7): connections per address and per instance and key (so a party without the key cannot use up
 * the instance's), messages per connection, and records of refused connections per instance; and open connections. A
 * snapshot at most each 2 s and a heartbeat each 30 s is 32 messages a minute. */
export const LIMITS = { connectsPerAddress: 30, connectsPerInstance: 10, messagesPerConnection: 120, refusalRecords: 5, connections: 10_000 };
const MINUTE = 60_000;

export interface CloudConnections {
  /** Takes the upgrades at LINK_PATH of the HTTP server hopper.io listens on. */
  attach(server: { on(event: 'upgrade', f: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown }): void;
  /** Whether the instance is connected now. */
  connected(installId: string): boolean;
  /** An owner entered a code for the instance: `register` goes to it now, when it is connected. */
  offer(installId: string): Promise<void>;
  /** The instance's registration was removed: `unregister` goes to it, and the connection closes, its key revoked. */
  revoke(installId: string): void;
  /** Closes every connection: hopper.io stops. */
  close(): void;
}

/** Counts events per key in the last minute; `take` is false over `max`. */
function perMinute(max: number, now: () => Date) {
  const seen = new Map<string, number[]>();
  return (key: string): boolean => {
    const t = now().getTime();
    const recent = (seen.get(key) ?? []).filter((at) => at > t - MINUTE);
    if (recent.length >= max) { seen.set(key, recent); return false; }
    recent.push(t);
    seen.set(key, recent);
    if (seen.size > LIMITS.connections * 2) for (const [k, v] of seen) if (v.every((at) => at <= t - MINUTE)) seen.delete(k);
    return true;
  };
}

interface Link { socket: WebSocket; hello: ProvedHello; registrant?: string; refusedOnce: boolean }

export function createCloudConnections(o: {
  store: Pick<CloudStore, 'record' | 'seen'>; answers: CloudLinkAnswers; trustProxy: boolean; now?: () => Date;
  limits?: Partial<typeof LIMITS>;
}): CloudConnections {
  const now = o.now ?? (() => new Date());
  const limits = { ...LIMITS, ...o.limits };
  const wss = new WebSocketServer({ noServer: true, maxPayload: SNAPSHOT_MAX_BYTES });
  const links = new Map<string, Link>();
  const byAddress = perMinute(limits.connectsPerAddress, now);
  const byInstance = perMinute(limits.connectsPerInstance, now);
  const refusals = perMinute(limits.refusalRecords, now);
  const record = (l: Pick<Link, 'registrant'>, kind: RecordKind) => l.registrant ? o.store.record(l.registrant, kind, now()).catch(() => undefined) : undefined;
  const send = (socket: WebSocket, text: string | undefined) => { if (text && socket.readyState === socket.OPEN) socket.send(text); };

  const address = (req: IncomingMessage): string => {
    const forwarded = o.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
    return forwarded || req.socket.remoteAddress || 'unknown';
  };

  /** One message from a connected instance; false: it is refused. */
  const take = async (l: Link, text: string): Promise<boolean> => {
    const { installId, account, publicKey } = l.hello;
    const t = now();
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return false; }
    const m = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as { type?: unknown; schema?: unknown }) : {};
    if (m.schema !== undefined) return o.answers.snapshot({ installId, account, text, now: t });
    if (Buffer.byteLength(text) > LINK_MESSAGE_MAX_BYTES) return false;
    switch (m.type) {
      case 'heartbeat':
        if (!HEARTBEAT_SCHEMA.safeParse(raw).success) return false;
        if (l.registrant) await o.store.seen(installId, t);
        return true;
      case 'registration':
        if (await o.answers.registration({ installId, account, publicKey, answer: text, now: t })) l.registrant = await registrantOf(l);
        return true;
      case 'unlinked':
        if (await o.answers.unlinked({ installId, notice: text, now: t })) delete l.registrant;
        return true;
      case 'unregistration': case 'refused': return true;
      default: return false;
    }
  };
  /** The account the instance is registered to now, by a hello of its own proved key. */
  const registrantOf = async (l: Link): Promise<string | undefined> => {
    const h = await o.answers.hello({ ...l.hello, now: now() });
    return h.connects ? h.registrant : undefined;
  };

  const open = (socket: WebSocket) => {
    const c = challenge();
    let link: Link | undefined;
    let idle: NodeJS.Timeout = setTimeout(() => socket.close(CLOSE.helloTimeout, 'no hello'), HELLO_MS);
    const awake = (ms: number, code: number, why: string) => { clearTimeout(idle); idle = setTimeout(() => socket.close(code, why), ms); };
    let queue = Promise.resolve();
    const perConnection = perMinute(limits.messagesPerConnection, now);
    /** The proved hello: the connection is this instance's from here on, or it is refused. */
    const hello = async (proved: ProvedHello) => {
      const h = await o.answers.hello({ ...proved, now: now() });
      if (socket.readyState !== socket.OPEN) return;
      if (!h.connects) {
        if (h.refused === 'unknown-key' && refusals(proved.installId)) await record(h, 'connection_refused');
        send(socket, h.answer);
        socket.close(h.refused === 'revoked' ? CLOSE.revoked : CLOSE.unknownKey, h.refused);
        return;
      }
      const before = links.get(proved.installId);
      link = { socket, hello: proved, ...(h.registrant ? { registrant: h.registrant } : {}), refusedOnce: false };
      links.set(proved.installId, link);
      if (before) { before.socket.close(CLOSE.replaced, 'replaced'); await record(link, 'connection_replaced'); }
      await record(link, 'instance_connected');
      send(socket, CONNECTED);
      send(socket, h.answer);
      send(socket, o.answers.registerMessage({ installId: proved.installId, account: proved.account, now: now() }));
    };
    /** A message after the hello. One that came before the close is still taken: the instance sends `unlinked`, then
     * closes at once (issue #2039 part 2). */
    const message = async (text: string | undefined) => {
      if (!link) return;
      if ((text === undefined || !await take(link, text)) && !link.refusedOnce) {
        link.refusedOnce = true;
        await record(link, 'message_refused');
      }
    };
    let proved: ProvedHello | undefined;
    socket.on('message', (data, binary) => {
      if (!perConnection('')) { socket.close(CLOSE.tooMany, 'too many messages'); return; }
      const text = binary ? undefined : data.toString();
      if (proved) {
        awake(IDLE_MS, CLOSE.idle, 'idle');
        queue = queue.then(() => message(text));
      } else {
        proved = text === undefined ? undefined : provedHello(text, c.nonce);
        if (!proved) { socket.close(CLOSE.badHello, 'bad hello'); return; }
        if (!byInstance(`${proved.installId}/${proved.publicKey}`)) { socket.close(CLOSE.tooMany, 'too many connections'); return; }
        awake(IDLE_MS, CLOSE.idle, 'idle');
        const p = proved;
        queue = queue.then(() => hello(p));
      }
      queue = queue.catch(() => socket.close(CLOSE.closing, 'error'));
    });
    socket.on('close', () => {
      clearTimeout(idle);
      if (link && links.get(link.hello.installId) === link) {
        links.delete(link.hello.installId);
        void record(link, 'instance_disconnected');
      }
    });
    socket.on('error', () => socket.terminate());
    socket.send(c.text);
  };

  return {
    attach(server) {
      server.on('upgrade', (req, socket, head) => {
        if (new URL(req.url ?? '/', 'http://hopper.io').pathname !== LINK_PATH) { socket.destroy(); return; }
        if (wss.clients.size >= limits.connections || !byAddress(address(req))) {
          socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        wss.handleUpgrade(req, socket, head, open);
      });
    },
    connected: (installId) => links.has(installId),
    async offer(installId) {
      const l = links.get(installId);
      if (l) send(l.socket, o.answers.registerMessage({ installId, account: l.hello.account, now: now() }));
    },
    revoke(installId) {
      const l = links.get(installId);
      if (!l) return;
      links.delete(installId);
      send(l.socket, JSON.stringify({ type: 'unregister', account: l.hello.account }));
      l.socket.close(CLOSE.revoked, 'revoked');
    },
    close() {
      for (const ws of wss.clients) ws.close(CLOSE.closing, 'hopper.io stops');
      links.clear();
      wss.close();
    },
  };
}
