// Machines joining and dialling in (design.md "Joining a machine", issue #308): the routes a machine — not
// a person — uses, outside the UI session, each on the hopper's own URL and behind the Host guard.
//
//   POST /client/join      a one-time join code (minted through an admin's UI session, or the operator CLI)
//                          and the machine's key: the machine is added as a client target. The code is
//                          what authorizes the write; it is spent by it.
//   GET  /client/connect   an HTTP/1.1 upgrade to `hopper-client/1`, signed with the client token: the
//                          machine's link. Refused unless a client target holds the machine key and the
//                          signature is its token's. Answered 101, the socket goes to the links.
//   GET  /client/install   the install script a computer's line pipes to sh (scripts/client-install.sh)
//   GET  /client/release   the hopper's client release, {id, files}: what that script installs
//
// The upgrade bypasses Fastify's hooks, so the Host guard's rule is applied here too (classifyRequest).
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONNECT_PATH, JOIN_PATH, LINK_PROTOCOL, MACHINE_KEY_HEADER, USER_HEADER } from '../client/link.ts';
import type { ClientRelease } from '../client/release.ts';
import { createNonceCache, verifyConnect } from '../client/signature.ts';
import type { Clock, InstanceStore } from '../domain/ports.ts';
import { useJoinCode } from '../machines/join-code.ts';
import type { MachineLinks } from '../machines/links.ts';
import { HttpError, parseWith } from './errors.ts';
import { classifyRequest, peerList, type Lan } from './reach.ts';
import type { Tenants } from './tenants.ts';

export interface ClientLinkOptions {
  tenants: Tenants;
  instance: Pick<InstanceStore, 'joinCodes'>;
  clock: Clock;
  port: () => number;
  lan: Lan;
  links: MachineLinks;
  /** The client release this hopper runs: what a computer installs, and what each client target is kept on. */
  release: ClientRelease;
  /** scripts/client-install.sh. */
  installScript: string;
}

const joinBody = z.strictObject({
  code: z.string(),
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'key must be the machine key: the public half of its link key'),
  name: z.string().min(1).max(63),
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

export function clientLinkRoutes(app: FastifyInstance, o: ClientLinkOptions): void {
  app.post(JOIN_PATH, async (req) => {
    const b = parseWith(joinBody, req.body);
    const taken = useJoinCode(o.instance, o.clock, b.code);
    if (taken === undefined) throw new HttpError(403, 'the join code is not valid: it was used, it expired, or it was never minted. Add machine shows a fresh line');
    const { userId, template } = taken;
    const tenant = o.tenants.user(userId);
    if (!tenant) throw new HttpError(404, `no user ${userId}`);
    const r = await tenant.machineLink.join({ key: b.key, name: b.name, ...(template ? { template } : {}) });
    if (!r.ok) throw new HttpError(409, r.error);
    return { user: userId, machine: r.machine, hopperKey: tenant.machineLink.hopperKey };
  });

  app.get('/client/install', async (_req, reply) => reply.type('text/x-shellscript; charset=utf-8').header('cache-control', 'no-cache').send(o.installScript));
  app.get('/client/release', async () => o.release);

  const peers = peerList(o.lan.peers);
  const nonces = createNonceCache();
  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const path = (req.url ?? '').split('?')[0];
    if (path !== CONNECT_PATH || header(req, 'upgrade').toLowerCase() !== LINK_PROTOCOL) return refuse(socket, 404, `not found: a machine dials in at ${CONNECT_PATH} with Upgrade: ${LINK_PROTOCOL}`);
    const reach = classifyRequest({ host: req.headers.host, peer: req.socket.remoteAddress }, o.port(), o.lan, peers);
    if ('refuse' in reach) {
      console.warn(`hopper: refused a machine's dial-in from ${req.socket.remoteAddress} Host ${JSON.stringify(req.headers.host ?? '')} (${reach.refuse}): ${reach.why}`);
      return refuse(socket, reach.refuse, reach.why);
    }
    const user = header(req, USER_HEADER);
    const key = header(req, MACHINE_KEY_HEADER);
    const token = o.tenants.user(user)?.machineLink.tokenFor(key);
    const verdict = token === undefined ? { ok: false as const, why: 'no machine holds that key' } : verifyConnect(token, header(req, 'x-hopper-signature'), user, key, nonces);
    if (!verdict.ok) {
      console.warn(`hopper: refused a machine's dial-in from ${req.socket.remoteAddress}: ${verdict.why}`);
      return refuse(socket, 401, `refused: ${verdict.why}. A removed machine is added again with Add machine`);
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: ${LINK_PROTOCOL}\r\nconnection: Upgrade\r\n\r\n`);
    if (head.length) socket.unshift(head);
    if ('setTimeout' in socket && typeof socket.setTimeout === 'function') socket.setTimeout(0);
    // Where the machine reached the hopper: its jobs ask the hopper there (issue #563). Behind the public URL the
    // scheme is the public URL's; on loopback or the LAN, plain http to the Host it named.
    o.links.accept(user, key, socket, reach.reach === 'public' ? o.lan.publicUrl : `http://${req.headers.host ?? ''}`);
  });
}
