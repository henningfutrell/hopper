// The job stream's routes (issue #613, design.md "The job stream"): a running job subscribes to its own stream events,
// outside the UI session, on the hopper's own URL and behind the Host guard, like the GitHub proxy (job-github.ts).
//
//   GET /job/stream                 `Authorization: Bearer <the job's proxy token>`. SSE: the job's stream events after
//                                   Last-Event-ID (else `?after=`), then live; `?request=ID` only that request's, and the
//                                   stream ends after its ending event. A ping every 15 s, at which the token is checked
//                                   again: the stream ends once its job is no longer at work.
//   GET /job/stream/results/:seq    the result a pointer names: the event whole, as JSON; its payload alone, when it is a
//                                   string and `Accept: text/plain` asks for it.
//
// 401: the token is no job's, or its job ended. 404: a request or result that is not the job's. 503 (Retry-After): the
// job is not at work now but has not ended (queued again after a restart): the job reconnects. It changes nothing.
import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ENDING_PHASES, type StreamEvent } from '../domain/job-stream.ts';
import { TERMINAL_STATUSES, type Job } from '../domain/types.ts';
import { parseProxyToken } from '../github-proxy/token.ts';
import { RESULT_PATH, resultOf, sseFrame, STREAM_PATH, type JobStream } from '../job-stream/index.ts';
import type { Tenants } from './tenants.ts';

const PING_MS = 15_000;
const REPLAY_PAGE = 500;
const AT_WORK = ['running', 'waiting_answer', 'waiting_on'];
const BEARER = /^Bearer\s+(\S+)$/i;

const seq = z.coerce.number().int().min(0);
const streamQuery = z.object({ after: seq.optional(), request: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional() });

type Who = { userId: string; job: Job; stream: JobStream } | { status: number; text: string };

/** Why a job not at work is not served now; undefined when it is at work. */
const notAtWork = (job: Job): { status: number; text: string } | undefined => (AT_WORK.includes(job.status) ? undefined
  : { status: 503, text: `retry: job ${job.id} is ${job.status}, not at work now: subscribe again in a moment.\n` });

/** The job the token names, not ended; else the answer that says why not. */
function jobOf(tenants: Tenants, authorization: string | undefined): Who {
  const parts = parseProxyToken(BEARER.exec(authorization ?? '')?.[1] ?? '');
  const user = parts ? tenants.user(parts.userId) : undefined;
  const job = parts && user?.githubProxy.user.holds(parts) ? user.githubProxy.user.job(parts.jobId) : undefined;
  if (!parts || !user || !job) return { status: 401, text: 'no: the token is not a job\'s of this hopper. A job subscribes with its own HOPPER_TOKEN_FILE.\n' };
  if (TERMINAL_STATUSES.includes(job.status)) return { status: 401, text: `no: job ${job.id} is ${job.status}: its stream is closed.\n` };
  return { userId: parts.userId, job, stream: user.jobStream };
}

const refuse = (reply: FastifyReply, who: { status: number; text: string }): FastifyReply => {
  if (who.status === 503) void reply.header('retry-after', '1');
  return reply.code(who.status).type('text/plain; charset=utf-8').send(who.text);
};

export function jobStreamRoutes(app: FastifyInstance, o: { tenants: Tenants; subscribed(userId: string, jobId: string): void }): void {
  const open = new Set<ServerResponse>();
  app.addHook('onClose', async () => {
    for (const res of open) res.end();
  });

  app.get(STREAM_PATH, (req, reply) => {
    const q = streamQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).type('text/plain; charset=utf-8').send('no: after is a number, request an id\n');
    const header = req.headers['last-event-id'];
    const fromHeader = typeof header === 'string' && header !== '' ? seq.safeParse(header) : undefined;
    if (fromHeader?.success === false) return reply.code(400).type('text/plain; charset=utf-8').send('no: Last-Event-ID is the seq of an event\n');
    const who = jobOf(o.tenants, req.headers.authorization);
    if ('status' in who) return refuse(reply, who);
    const { job, stream } = who;
    const request = q.data.request;
    if (request !== undefined && stream.repo.watch(request)?.jobId !== job.id) return reply.code(404).type('text/plain; charset=utf-8').send(`no: job ${job.id} waits on no request ${request}\n`);
    const idle = notAtWork(job);
    if (idle) return refuse(reply, idle);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 1000\n\n');
    open.add(res);

    let lastSeq = fromHeader?.data ?? q.data.after ?? 0;
    let ended = false;
    const send = (e: StreamEvent): void => {
      if (ended || e.seq <= lastSeq || (request !== undefined && e.request !== request)) return;
      lastSeq = e.seq;
      res.write(sseFrame(e, stream.inlineMax));
      if (request !== undefined && ENDING_PHASES.includes(e.phase)) {
        ended = true;
        res.end();
      }
    };
    // Subscribe first, then replay, so nothing kept in between is lost.
    const unsubscribe = stream.repo.subscribe((jobId, e) => { if (jobId === job.id) send(e); });
    for (let page = stream.repo.since(job.id, lastSeq, REPLAY_PAGE, request); page.length > 0 && !ended; page = stream.repo.since(job.id, lastSeq, REPLAY_PAGE, request)) {
      for (const e of page) send(e);
      if (page.length < REPLAY_PAGE) break;
    }
    // The token holds for as long as its job is at work: checked again at each ping.
    const ping = setInterval(() => {
      const now = jobOf(o.tenants, req.headers.authorization);
      if ('status' in now || notAtWork(now.job)) res.end();
      else res.write(': ping\n\n');
    }, PING_MS);
    ping.unref();
    res.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      open.delete(res);
    });
    // What the job waits on may be ready now: after a restart, the request is asked again.
    if (!ended) o.subscribed(who.userId, job.id);
  });

  app.get<{ Params: { seq: string } }>(`${RESULT_PATH}/:seq`, async (req, reply) => {
    const who = jobOf(o.tenants, req.headers.authorization);
    if ('status' in who) return refuse(reply, who);
    const idle = notAtWork(who.job);
    if (idle) return refuse(reply, idle);
    const n = seq.safeParse(req.params.seq);
    const e = n.success ? who.stream.repo.get(who.job.id, n.data) : undefined;
    if (!e) return reply.code(404).type('text/plain; charset=utf-8').send(`no: job ${who.job.id} has no result ${req.params.seq}\n`);
    if (typeof e.payload === 'string' && /^text\/plain\b/.test(req.headers.accept ?? '')) return reply.type('text/plain; charset=utf-8').send(e.payload);
    return reply.type('application/json; charset=utf-8').send(resultOf(e));
  });
}
