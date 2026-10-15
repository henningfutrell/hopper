// The Host guard (design.md "Read-only API", "Reaching the UI across the LAN"): every request —
// GET, SSE and the UI included — must name this daemon in Host with the bound port: 127.0.0.1 or
// localhost from loopback, a LAN name, or the public URL's host. Another Host is 421, so a page on
// another name that resolves here reads nothing; a peer outside loopback and the LAN peers is 403.
// A LAN or public request reads /api/ only with a live UI session: the x-hopper-session header,
// or for the event stream (EventSource sends no headers) the `session` query parameter — or with a token
// in `Authorization` (the API door, issue #255), which the tenancy hook checks next (src/http/tenants.ts).
// One exception (issue #712): a LAN read of `GET /api/health` without a session, which has no user and so answers the
// instance's health only, `{ ok, version, uptimeS }` — so a probe on the same machine (Windows beside a hopper in WSL)
// learns the hopper is up. A public request still needs a session.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { classifyRequest, peerList, type Lan } from './reach.ts';
import { SESSION_HEADER, sessionIn, sessionTokenIn } from './ui/guard.ts';
import type { UiSession, UiSessions } from './ui/sessions.ts';

const STREAM = '/api/events/stream';
const HEALTH = '/api/health';

/** A LAN read of the instance's health (issue #712): open without a session. */
const lanHealth = (req: FastifyRequest, reach: 'lan' | 'public'): boolean =>
  reach === 'lan' && (req.method === 'GET' || req.method === 'HEAD') && req.url.split('?')[0] === HEALTH;

/** The event stream's `session` query parameter (EventSource sends no headers), or undefined. */
function streamToken(req: FastifyRequest): string | undefined {
  if (req.headers[SESSION_HEADER] !== undefined || req.url.split('?')[0] !== STREAM) return undefined;
  const q = (req.query as Record<string, unknown> | undefined)?.session;
  return typeof q === 'string' ? q : undefined;
}

/** The request's session token: the header, an API token in `Authorization` (issue #718), or for the event stream its `session` query parameter. */
export const sessionToken = (req: FastifyRequest): string | undefined => sessionTokenIn(req.headers) ?? streamToken(req);

/** The request's live session: a UI session (its header, or the event stream's parameter) or an API token (`Authorization`). */
export function requestSession(req: FastifyRequest, sessions: UiSessions): UiSession | undefined {
  const q = streamToken(req);
  if (q === undefined) return sessionIn(req.headers, sessions);
  const s = sessions.find(q);
  return s?.kind === 'ui' ? s : undefined;
}

/** A read of /api/ carrying `Authorization`: the API door (issue #255) or an API token (issue #718), checked by the tenancy hook. */
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
    if (r.reach !== 'local' && req.url.startsWith('/api/') && !atApiDoor(req) && !requestSession(req, o.sessions) && !lanHealth(req, r.reach)) {
      return reply.code(401).send({ error: r.reach === 'lan' ? 'log in to read across the LAN: sign in, or open a device link from a logged-in browser' : 'sign in to read' });
    }
  });
}
