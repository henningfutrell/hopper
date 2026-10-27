// Machines joining and dialling in (design.md "Joining a machine", issue #308): the routes a machine — not
// a person — uses, outside the UI session, each on the hopper's own URL and behind the Host guard.
//
//   POST /client/join      a one-time join code (minted through an admin's UI session, or the operator CLI)
//                          and the machine's key: the machine is added as a client target. The code is
//                          what authorizes the write; it is spent by it, and that machine's join sent again
//                          is answered as the first until the code expires (issue #1628). Or the lane pool key (issue #1284), never
//                          spent: a lane pod joins as the first user's machine (the oldest user, issue #1767), under its own name; or a lane pool
//                          key the hopper issued (issue #1454), the same, as its user's machine.
//   POST /client/leave     a machine's say that it leaves (issue #1284), signed with its client token over its
//                          user and machine key: it takes no new job; a lane pod with no job left is retired.
//   GET  /client/connect   an HTTP/1.1 upgrade to `hopper-client/1`, signed with the client token: the
//                          machine's link. Refused unless a client target holds the machine key and the
//                          signature is its token's. Answered 101, the socket goes to the links.
//   POST /client/vault     a machine's ask for one vault secret (issue #558, design.md "The vault"), signed with its
//                          client token over its user, its machine key and the body, and carrying the job's proxy token
//                          (issue #563): the value answered only sealed to that one request under the client token,
//                          never cached. It changes no job, question or setting: it records the delivery or refusal.
//   GET  /client/install   the install script a computer's line pipes to sh (scripts/client-install.sh)
//   GET  /client/release   the hopper's client release, {id, files}: what that script installs
//
// The upgrade bypasses Fastify's hooks, so the Host guard's rule is applied here too (classifyRequest).
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONNECT_PATH, JOIN_PATH, LEAVE_PATH, LINK_PROTOCOL, MACHINE_KEY_HEADER, USER_HEADER } from '../client/link.ts';
import type { ClientRelease } from '../client/release.ts';
import { HELD_CREDIT_MS, REQUEST_HEADER, WINDOW_MS, createNonceCache, nonceOf, verifyConnect, verifyLeave, verifyVault, type HeldSince } from '../client/signature.ts';
import { askOf, sealAnswer, VAULT_CONTENT_TYPE, VAULT_PATH } from '../client/vault.ts';
import type { Clock, InstanceStore, JoinCodePlace } from '../domain/ports.ts';
import { useJoinCode } from '../machines/join-code.ts';
import { isLanePoolKey, issuedLanePoolUser, lanePoolUser } from '../machines/lane-pool.ts';
import type { MachineLinks } from '../machines/links.ts';
import { HttpError, parseWith } from './errors.ts';
import { classifyRequest, peerList, publicOriginOf, type Lan } from './reach.ts';
import type { Tenants } from './tenants.ts';
import { holdsTemplate } from '../vault/vault.ts';
import { RELAY_PATH } from '../sandbox/relay-script.ts'; import { JOB_EGRESS_PATH } from './job-egress.ts';

export interface ClientLinkOptions {
  tenants: Tenants;
  instance: Pick<InstanceStore, 'joinCodes' | 'lanePoolKeys' | 'users'>;
  clock: Clock;
  port: () => number;
  lan: Lan;
  links: MachineLinks;
  /** The client release this hopper runs: what a computer installs, and what each client target is kept on. */
  release: ClientRelease;
  /** scripts/client-install.sh. */
  installScript: string;
  /** The lane pool key (issue #1284), read at each join; undefined: this hopper has no lane pool. */
  poolKey?: () => string | undefined;
  /**
   * How long the event loop was held since a moment (issue #1383): a machine's signed ask that waited behind a stall is
   * not stale for that time. Absent: none.
   */
  heldSince?: HeldSince;
}

/** A nonce is kept as long as an ask that carries it may be fresh: the window and the held credit, both ways. */
const nonceCache = () => createNonceCache(WINDOW_MS + HELD_CREDIT_MS);

const joinBody = z.strictObject({
  code: z.string(),
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'key must be the machine key: the public half of its link key'),
  name: z.string().min(1).max(63),
  /** Node's `process.platform` on the machine (issue #704). Every platform joins, native Windows too (issue #1348). */
  platform: z.string().max(32).optional(),
});

const STATUS: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 421: 'Misdirected Request' };

/** An answer on a socket that will not be upgraded, then the socket closed. */
function refuse(socket: Duplex, status: number, error: string): void {
  const body = JSON.stringify({ error });
  socket.end(`HTTP/1.1 ${status} ${STATUS[status] ?? 'Refused'}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

const header = (req: IncomingMessage, name: string): string => {
  const v = req.headers[name];
  return typeof v === 'string' ? v : '';
};

const NOBODY_YET = 'the lane pods are the machines of the first person to sign in, and nobody has signed in yet: sign in, and the pod joins at its next try';

export function clientLinkRoutes(app: FastifyInstance, o: ClientLinkOptions): void {
  app.post(JOIN_PATH, async (req) => {
    const b = parseWith(joinBody, req.body);
    const installed = isLanePoolKey(o.poolKey?.(), b.code);
    const issued = installed ? undefined : issuedLanePoolUser(o.instance, b.code);
    const pool = installed || issued !== undefined;
    const first = installed ? lanePoolUser(o.instance.users) : undefined;
    if (installed && first === undefined) throw new HttpError(409, NOBODY_YET);
    const taken: ({ userId: string } & JoinCodePlace) | undefined = first !== undefined ? { userId: first } : issued !== undefined ? { userId: issued } : useJoinCode(o.instance, o.clock, b.code, b.key);
    if (taken === undefined) throw new HttpError(403, 'the join code is not valid: another machine used it, it expired, or it was never minted. Add machine shows a fresh line');
    const { userId, template, pod } = taken;
    const tenant = o.tenants.user(userId);
    if (!tenant && pool) throw new HttpError(409, NOBODY_YET);
    if (!tenant) throw new HttpError(404, `no user ${userId}`);
    // The template may have been removed since the code was minted (issue #604): no box joins as one that is not there.
    if (template && !holdsTemplate(tenant.vault, template)) throw new HttpError(409, `no template ${template}: it was removed after the join line was made. Add machine shows a fresh line`);
    const r = await tenant.machineLink.join({ key: b.key, name: b.name, ...(template ? { template } : {}), ...(pool ? { pool: true as const } : {}), ...(pod ? { pod } : {}) });
    if (!r.ok) throw new HttpError(409, r.error);
    return { user: userId, machine: r.machine, hopperKey: tenant.machineLink.hopperKey };
  });

  // The body is the bytes the machine signed: kept as text, parsed only after the signature holds.
  app.addContentTypeParser(VAULT_CONTENT_TYPE, { parseAs: 'string' }, (_req, body, done) => { done(null, body); });
  const vaultNonces = nonceCache();
  app.post(VAULT_PATH, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const user = header(req.raw, USER_HEADER);
    const key = header(req.raw, MACHINE_KEY_HEADER);
    const body = typeof req.body === 'string' ? req.body : '';
    const tenant = o.tenants.user(user);
    const token = tenant?.machineLink.tokenFor(key);
    const signature = header(req.raw, REQUEST_HEADER);
    const verdict = token === undefined ? { ok: false as const, why: 'no machine holds that key' } : verifyVault(token, signature, user, key, body, vaultNonces, Date.now(), o.heldSince);
    if (!verdict.ok || !tenant || token === undefined) {
      const why = verdict.ok ? 'no such user' : verdict.why;
      console.warn(`hopper: refused a vault ask from ${req.socket.remoteAddress}: ${why}`);
      throw new HttpError(401, `refused: ${why}`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new HttpError(400, 'the ask must be JSON'); }
    const ask = askOf(parsed);
    if (typeof ask === 'string') throw new HttpError(400, ask);
    const r = 'name' in ask ? await tenant.vault.deliver(ask, key) : await tenant.vault.mint(ask, key);
    if ('refused' in r) throw new HttpError(403, r.refused);
    return sealAnswer(token, nonceOf(signature), ask, r.value);
  });

  const leaveNonces = nonceCache();
  app.post(LEAVE_PATH, async (req) => {
    const user = header(req.raw, USER_HEADER);
    const key = header(req.raw, MACHINE_KEY_HEADER);
    const tenant = o.tenants.user(user);
    const token = tenant?.machineLink.tokenFor(key);
    const verdict = token === undefined ? { ok: false as const, why: 'no machine holds that key' } : verifyLeave(token, header(req.raw, REQUEST_HEADER), user, key, leaveNonces, Date.now(), o.heldSince);
    if (!verdict.ok || !tenant) {
      console.warn(`hopper: refused a machine's leave from ${req.socket.remoteAddress}: ${verdict.ok ? 'no such user' : verdict.why}`);
      throw new HttpError(401, `refused: ${verdict.ok ? 'no such user' : verdict.why}`);
    }
    return tenant.machineLink.leave(key);
  });

  app.get('/client/install', async (_req, reply) => reply.type('text/x-shellscript; charset=utf-8').header('cache-control', 'no-cache').send(o.installScript));
  app.get('/client/release', async () => o.release);

  const peers = peerList(o.lan.peers);
  const nonces = nonceCache();
  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === RELAY_PATH || path === JOB_EGRESS_PATH) return; // a job's relay connection (issue #2146): job-relay.ts; its egress (issue #2849): job-egress.ts
    socket.on('error', () => socket.destroy());
    if (path !== CONNECT_PATH || header(req, 'upgrade').toLowerCase() !== LINK_PROTOCOL) return refuse(socket, 404, `not found: a machine dials in at ${CONNECT_PATH} with Upgrade: ${LINK_PROTOCOL}`);
    const reach = classifyRequest({ host: req.headers.host, peer: req.socket.remoteAddress }, o.port(), o.lan, peers);
    if ('refuse' in reach) {
      console.warn(`hopper: refused a machine's dial-in from ${req.socket.remoteAddress} Host ${JSON.stringify(req.headers.host ?? '')} (${reach.refuse}): ${reach.why}`);
      return refuse(socket, reach.refuse, reach.why);
    }
    const user = header(req, USER_HEADER);
    const key = header(req, MACHINE_KEY_HEADER);
    const token = o.tenants.user(user)?.machineLink.tokenFor(key);
    const verdict = token === undefined ? { ok: false as const, why: 'no machine holds that key' } : verifyConnect(token, header(req, 'x-hopper-signature'), user, key, nonces, Date.now(), o.heldSince);
    if (!verdict.ok) {
      console.warn(`hopper: refused a machine's dial-in from ${req.socket.remoteAddress}: ${verdict.why}`);
      return refuse(socket, 401, `refused: ${verdict.why}. A removed machine is added again with Add machine`);
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: ${LINK_PROTOCOL}\r\nconnection: Upgrade\r\n\r\n`);
    if (head.length) socket.unshift(head);
    if ('setTimeout' in socket && typeof socket.setTimeout === 'function') socket.setTimeout(0);
    // Where the machine reached the hopper: its jobs ask the hopper there (issue #563). Behind the public URL the
    // scheme is the public URL's (or the remote access URL's); on loopback or the LAN, plain http to the Host it named.
    o.links.accept(user, key, socket, reach.reach === 'public' ? publicOriginOf(o.lan, req.headers.host ?? '') : `http://${req.headers.host ?? ''}`);
  });
}
