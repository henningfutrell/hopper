// The Host guard (design.md "Read-only API", "Reaching the UI across the LAN"): every request —
// GET, SSE and the UI included — must name this daemon in Host with the bound port: 127.0.0.1 or
// localhost from loopback, a LAN name, or the public URL's host. Another Host is 421, so a page on
// another name that resolves here reads nothing; a peer outside loopback and the LAN peers is 403.
// A LAN or public request reads /api/ only with a live UI session: the x-hopper-session header,
// or for the event stream (EventSource sends no headers) the `session` query parameter — or with a token
// in `Authorization` (the API door, issue #255), which the tenancy hook checks next (src/http/tenants.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { classifyRequest, peerList, type Lan } from './reach.ts';
import { SESSION_HEADER } from './ui/guard.ts';
import type { UiSessions } from './ui/sessions.ts';

const STREAM = '/api/events/stream';

/** The request's UI session token: the header, or for the event stream its `session` query parameter. */
export function sessionToken(req: FastifyRequest): string | undefined {
  const header = req.headers[SESSION_HEADER];
  if (typeof header === 'string') return header;
  if (req.url.split('?')[0] !== STREAM) return undefined;
  const q = (req.query as Record<string, unknown> | undefined)?.session;
  return typeof q === 'string' ? q : undefined;
}

/** A read of /api/ carrying `Authorization`: the API door (issue #255), checked by the tenancy hook. */
export const atApiDoor = (req: FastifyRequest): boolean => req.url.startsWith('/api/') && typeof req.headers.authorization === 'string';

export function installHostGuard(app: FastifyInstance, o: { port: () => number; lan: Lan; sessions: UiSessions }): void {
  const peers = peerList(o.lan.peers);
  app.addHook('onRequest', async (req, reply) => {
    const r = classifyRequest({ host: req.headers.host, peer: req.socket.remoteAddress }, o.port(), o.lan, peers);
    if ('refuse' in r) {
      console.warn(`hopper: refused ${req.method} ${req.url.split('?')[0]} from ${req.socket.remoteAddress} Host ${JSON.stringify(req.headers.host ?? '')} (${r.refuse}): ${r.why}`);
      return reply.code(r.refuse).send({ error: r.why });
    }
    // Every request of a session renews it (issue #439); one that has ended is gone before anything reads it.
    await o.sessions.renew(sessionToken(req), req.headers);
    if (r.reach !== 'local' && req.url.startsWith('/api/') && !atApiDoor(req) && !o.sessions.find(sessionToken(req))) {
      return reply.code(401).send({ error: r.reach === 'lan' ? 'log in to read across the LAN: sign in, or open a device link from a logged-in browser' : 'sign in to read' });
    }
  });
}
