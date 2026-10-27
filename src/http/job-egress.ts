// A running job's egress (issue #2849, design.md "A job's egress allowlist"): a job's connection out, made by the hopper
// only to a host on the job's egress allowlist, outside the UI session, on the hopper's own URL and behind the Host guard.
//
//   GET /job/egress?to=<host>:<port>   an HTTP/1.1 upgrade to `hopper-egress/1`, with `Authorization: Bearer <the job's
//                    proxy token>`, only while the job is at work. When its user's allowlist holds the host and port for
//                    the job's repository (src/domain/job-egress.ts), the hopper connects to it and answers 101: the
//                    connection is a byte pipe to that host, TLS and all, as an HTTP CONNECT proxy's is. A no is plain
//                    text, `no: <reason>`, with its status: 403 for a host off the allowlist, or a listed name that
//                    resolves to a loopback, link-local or unspecified address (an address an admin listed as such is
//                    reached as listed); 502 for a host that did not answer. A 403 is recorded as `job.egress_denied`
//                    on the job, once per job, host and port while the hopper runs. It changes no job, question,
//                    webhook or setting.
//
// The upgrade bypasses Fastify's hooks, so the Host guard's rule is applied here too (classifyRequest), as for the relay
// (job-relay.ts).
import { lookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { jobEgressAllows, jobEgressList } from '../domain/job-egress.ts';
import type { JobStatus } from '../domain/types.ts';
import { parseProxyToken } from '../github-proxy/token.ts';
import { classifyRequest, peerList, type Lan } from './reach.ts';
import type { Tenants } from './tenants.ts';

/** The route on the hopper's URL a job's connection out goes to, and the upgrade's protocol. */
export const JOB_EGRESS_PATH = '/job/egress';
export const JOB_EGRESS_PROTOCOL = 'hopper-egress/1';

const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];
const BEARER = /^Bearer\s+(\S+)$/i;
/** `host:port`: a DNS name or an IPv4 address. */
const TARGET = /^([A-Za-z0-9]([A-Za-z0-9.-]{0,252}[A-Za-z0-9])?):([1-9][0-9]{0,4})$/;
/** How long the hopper waits for the host to take the connection. */
const CONNECT_MS = 10_000;
/** How many denials the hopper keeps in memory to record each once; past it, it starts again. */
const DENIALS_KEPT = 10_000;
const STATUS: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 421: 'Misdirected Request', 502: 'Bad Gateway' };

function refuse(socket: Duplex, status: number, no: string): void {
  const body = `no: ${no}\n`;
  socket.end(`HTTP/1.1 ${status} ${STATUS[status] ?? 'Refused'}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
}

/** Whether `address` is loopback, link-local or unspecified: never reached by a name through the hopper. */
export function localAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(a) === 4) return a.startsWith('127.') || a.startsWith('169.254.') || a === '0.0.0.0';
  return a === '::1' || a === '::' || /^fe[89ab]/.test(a);
}

/** The address to connect to: a listed address as it is; a name's first address, or why not. */
async function addressOf(host: string): Promise<{ address: string } | { local: true } | { failed: string }> {
  if (isIP(host)) return { address: host };
  try {
    const all = await lookup(host, { all: true });
    if (all.length === 0) return { failed: 'no address' };
    return all.some((a) => localAddress(a.address)) ? { local: true } : { address: all[0]!.address };
  } catch (e) {
    return { failed: e instanceof Error ? e.message : String(e) };
  }
}

/** The connection to `address`, once it is made; or why not. */
function dial(address: string, port: number): Promise<Socket | { failed: string }> {
  return new Promise((resolve) => {
    const out = connect({ host: address, port });
    const fail = (why: string): void => { out.destroy(); resolve({ failed: why }); };
    out.setTimeout(CONNECT_MS, () => fail(`no answer in ${CONNECT_MS / 1000} s`));
    out.once('error', (e) => fail(e.message));
    out.once('connect', () => { out.setTimeout(0); out.removeAllListeners('error'); resolve(out); });
  });
}

export function jobEgressRoutes(app: FastifyInstance, o: { tenants: Tenants; port: () => number; lan: Lan }): void {
  const peers = peerList(o.lan.peers);
  const denied = new Set<string>();
  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://hopper');
    if (url.pathname !== JOB_EGRESS_PATH) return;
    socket.on('error', () => socket.destroy());
    if (String(req.headers.upgrade ?? '').toLowerCase() !== JOB_EGRESS_PROTOCOL) return refuse(socket, 400, `the job's egress takes Upgrade: ${JOB_EGRESS_PROTOCOL}`);
    const reach = classifyRequest({ host: req.headers.host, peer: req.socket.remoteAddress }, o.port(), o.lan, peers);
    if ('refuse' in reach) return refuse(socket, reach.refuse, reach.why);
    const parts = parseProxyToken(BEARER.exec(req.headers.authorization ?? '')?.[1] ?? '');
    const t = parts ? o.tenants.user(parts.userId) : undefined;
    const job = parts && t?.githubProxy.user.holds(parts) ? t.githubProxy.user.job(parts.jobId) : undefined;
    if (!t || !job) return refuse(socket, 401, 'the token is not a job\'s of this hopper. A job connects with its own HOPPER_TOKEN_FILE.');
    if (!AT_WORK.includes(job.status)) return refuse(socket, 401, `job ${job.id} is ${job.status}, not at work: only a job at work connects out.`);
    const m = TARGET.exec(url.searchParams.get('to') ?? '');
    if (!m || Number(m[3]) > 65535) return refuse(socket, 400, 'name the host: ?to=<host>:<port>');
    const host = m[1]!.toLowerCase().replace(/\.$/, '');
    const port = Number(m[3]);
    const repo = job.source?.repo;
    const deny = (reason: 'not_listed' | 'local_address', no: string): void => {
      const key = `${parts!.userId}/${job.id}/${host}:${port}`;
      if (!denied.has(key)) {
        if (denied.size >= DENIALS_KEPT) denied.clear();
        denied.add(key);
        t.store.events.append({ type: 'job.egress_denied', jobId: job.id, data: { host, port, ...(repo ? { repo } : {}), reason } });
      }
      refuse(socket, 403, no);
    };
    if (!jobEgressAllows(jobEgressList(t.store.settings.getJobEgress(), repo), host, port)) {
      return deny('not_listed', `${host}:${port} is not on the egress allowlist of job ${job.id}. An admin adds it in Settings → Job egress (POST /ui/api/job-egress), for every job or for ${repo ?? 'its repository'}.`);
    }
    socket.pause();
    void addressOf(host).then(async (at) => {
      if ('local' in at) return deny('local_address', `${host}:${port} resolves to a loopback or link-local address, which a job never reaches by a name.`);
      if ('failed' in at) return refuse(socket, 502, `${host}:${port}: ${at.failed}`);
      const out = await dial(at.address, port);
      if ('failed' in out) return refuse(socket, 502, `${host}:${port} did not take the connection: ${out.failed}`);
      if (socket.destroyed) { out.destroy(); return; }
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: ${JOB_EGRESS_PROTOCOL}\r\nconnection: Upgrade\r\n\r\n`);
      if ('setTimeout' in socket && typeof socket.setTimeout === 'function') socket.setTimeout(0);
      if (head.length) out.write(head);
      out.on('error', () => socket.destroy());
      socket.on('close', () => out.destroy());
      out.on('close', () => { if (!socket.writableEnded) socket.destroy(); });
      socket.pipe(out);
      out.pipe(socket);
      socket.resume();
    });
  });
}
