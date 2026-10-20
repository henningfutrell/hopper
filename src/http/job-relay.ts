// The relay's route (issue #2146, the bastion path, part 2; design.md "Bastions"): a running job's connection to one of
// its own bastion's targets, outside the UI session, on the hopper's own URL and behind the Host guard.
//
//   GET /job/relay?target=<cluster>/<namespace>/<kind>/<name>:<port>   an HTTP/1.1 upgrade to `hopper-relay/1`, with
//                    `Authorization: Bearer <the job's proxy token>`, only while the job is at work. Answered 101, the
//                    connection is a byte pipe to that target's forward in the job's bastion (Bastions.relay): what
//                    the job writes goes to the target, and what the target answers comes back. A no is plain text,
//                    `no: <reason>`, with its status. It changes no job, question, webhook or setting.
//
// The upgrade bypasses Fastify's hooks, so the Host guard's rule is applied here too (classifyRequest), as for a
// machine's dial-in (client-link.ts). `hopper-relay` (src/sandbox/relay-script.ts) is what a job runs to use it.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { JobStatus } from '../domain/types.ts';
import { parseProxyToken } from '../github-proxy/token.ts';
import { RELAY_PATH, RELAY_PROTOCOL } from '../sandbox/relay-script.ts';
import { classifyRequest, peerList, type Lan } from './reach.ts';
import type { Tenants } from './tenants.ts';

const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];
const BEARER = /^Bearer\s+(\S+)$/i;
const STATUS: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 409: 'Conflict', 421: 'Misdirected Request', 502: 'Bad Gateway', 503: 'Service Unavailable' };

/** A no on a socket that will not be upgraded, then the socket closed. */
function refuse(socket: Duplex, status: number, no: string): void {
  const body = `no: ${no}\n`;
  socket.end(`HTTP/1.1 ${status} ${STATUS[status] ?? 'Refused'}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

export function jobRelayRoutes(app: FastifyInstance, o: { tenants: Tenants; port: () => number; lan: Lan }): void {
  const peers = peerList(o.lan.peers);
  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://hopper');
    if (url.pathname !== RELAY_PATH) return;
    socket.on('error', () => socket.destroy());
    if (String(req.headers.upgrade ?? '').toLowerCase() !== RELAY_PROTOCOL) return refuse(socket, 400, `the relay takes Upgrade: ${RELAY_PROTOCOL}`);
    const reach = classifyRequest({ host: req.headers.host, peer: req.socket.remoteAddress }, o.port(), o.lan, peers);
    if ('refuse' in reach) return refuse(socket, reach.refuse, reach.why);
    const parts = parseProxyToken(BEARER.exec(req.headers.authorization ?? '')?.[1] ?? '');
    const t = parts ? o.tenants.user(parts.userId) : undefined;
    const job = parts && t?.githubProxy.user.holds(parts) ? t.githubProxy.user.job(parts.jobId) : undefined;
    if (!t || !job) return refuse(socket, 401, 'the token is not a job\'s of this hopper. A job connects with its own HOPPER_TOKEN_FILE.');
    if (!AT_WORK.includes(job.status)) return refuse(socket, 401, `job ${job.id} is ${job.status}, not at work: only a job at work uses its bastion.`);
    const target = url.searchParams.get('target') ?? '';
    if (!target) return refuse(socket, 400, 'name the target: ?target=<cluster>/<namespace>/<svc|pod|deploy>/<name>:<port>');
    socket.pause();
    void t.bastions.relay(job.id, target).then((pipe) => {
      if ('no' in pipe) return refuse(socket, pipe.status, pipe.no);
      if (socket.destroyed) { pipe.destroy(); return; }
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: ${RELAY_PROTOCOL}\r\nconnection: Upgrade\r\n\r\n`);
      if ('setTimeout' in socket && typeof socket.setTimeout === 'function') socket.setTimeout(0);
      if (head.length) pipe.write(head);
      // A pipe that ends (its command ended, the bastion ended) ends the job's connection once its last bytes are sent.
      pipe.on('error', () => socket.destroy()).on('close', () => { if (!socket.writableEnded) socket.end(); });
      socket.on('close', () => pipe.destroy());
      // An end of the job's writes ends the command's stdin; the rest of the target's answer still comes back.
      socket.pipe(pipe);
      pipe.pipe(socket);
      socket.resume();
    }, (e: unknown) => refuse(socket, 502, e instanceof Error ? e.message : String(e)));
  });
}
