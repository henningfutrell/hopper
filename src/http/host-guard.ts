// The Host guard (design.md "Read-only API", "Reaching the UI across the LAN"): every request —
// GET, SSE and the UI included — must name this daemon in Host with the bound port: 127.0.0.1 or
// localhost from loopback, or a LAN name. Another Host is 421, so a page on another name that
// resolves here reads nothing; a peer outside loopback and the LAN peers is 403. A LAN request
// reads /api/ only with a live UI session: the x-jobhopper-session header, or for the event
// stream (EventSource sends no headers) the `session` query parameter.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { classifyRequest, peerList, type Lan } from './reach.ts';
import { SESSION_HEADER } from './ui/guard.ts';
import type { UiSessions } from './ui/sessions.ts';

const STREAM = '/api/events/stream';

function sessionToken(req: FastifyRequest): string | undefined {
  const header = req.headers[SESSION_HEADER];
  if (typeof header === 'string') return header;
  if (req.url.split('?')[0] !== STREAM) return undefined;
  const q = (req.query as Record<string, unknown> | undefined)?.session;
  return typeof q === 'string' ? q : undefined;
}

export function installHostGuard(app: FastifyInstance, o: { port: () => number; lan: Lan; sessions: UiSessions }): void {
  const peers = peerList(o.lan.peers);
  app.addHook('onRequest', async (req, reply) => {
    const r = classifyRequest({ host: req.headers.host, peer: req.socket.remoteAddress }, o.port(), o.lan, peers);
    if ('refuse' in r) {
      console.warn(`job-hopper: refused ${req.method} ${req.url.split('?')[0]} from ${req.socket.remoteAddress} Host ${JSON.stringify(req.headers.host ?? '')} (${r.refuse}): ${r.why}`);
      return reply.code(r.refuse).send({ error: r.why });
    }
    if (r.reach === 'lan' && req.url.startsWith('/api/') && !o.sessions.find(sessionToken(req))) {
      return reply.code(401).send({ error: 'log in to read across the LAN: open a device link from a logged-in browser' });
    }
  });
}
