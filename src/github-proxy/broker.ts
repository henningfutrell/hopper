// The GitHub proxy (issue #563, design.md "GitHub through the hopper"): a running job asks the hopper for a
// GitHub operation, and the hopper does it with its own GitHub connection — the job's machine holds no GitHub
// login, and no device code is spent. Each request is, in order: the job's proxy token checked (its job at
// work), the request's shape checked, the asker checked (policy.ts), the rate limits taken (limits.ts), then
// done on GitHub (`github_proxy.done`, `.refused`, `.failed`). Every outcome but a token that names no job is
// an event on the job's timeline; a request of
// another user's job is also an event of the hopper's own user, whose connection it would act with.
import { randomUUID } from 'node:crypto';
import type { Job, JobStatus, NewEvent } from '../domain/types.ts';
import { ProxyGitHubError, type ProxyApi } from './api.ts';
import type { ProxyLimiter } from './limits.ts';
import { checkRequest, filedNote, proxyRequest, type ProxyRequest } from './policy.ts';
import { parseProxyToken, type ProxyTokenParts } from './token.ts';

/** The statuses whose jobs may ask: the job's processes are at work on its machine. */
const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer'];

/** One user's side: their jobs, the check of a token against their link key, and their event log. */
export interface ProxyUser {
  id: string;
  holds(parts: ProxyTokenParts): boolean;
  job(jobId: string): Job | undefined;
  /** The machine the job runs on now; undefined when it holds no lane. */
  machineOf(job: Job): string | undefined;
  record(event: NewEvent): void;
}

/** The hopper's own GitHub connection: the repositories it works on, and its calls; or why it has none. */
export interface ProxyConnection {
  jobRepositories(): string[];
  api(): ProxyApi | { problem: string };
}

export interface ProxyAnswer { status: number; body: Record<string, unknown> }

export interface GitHubProxy {
  /** One request: `authorization` as the job sent it, `body` its fields. Never throws. */
  handle(authorization: string | undefined, body: unknown): Promise<ProxyAnswer>;
}

export interface GitHubProxyOptions {
  user(id: string): ProxyUser | undefined;
  /** The user whose GitHub connection the hopper acts with (the oldest), and that connection; undefined: no user yet. */
  hopper(): { user: ProxyUser; connection: ProxyConnection } | undefined;
  limiter: ProxyLimiter;
  log(line: string): void;
  newId?: () => string;
}

const BEARER = /^Bearer\s+(\S+)$/i;

/** A job's own repository: its source's, or for a fork its parent's (issue #548). */
const repoOf = (job: Job): string | undefined => job.source?.repo ?? job.forkOf?.source?.repo;

export function createGitHubProxy(o: GitHubProxyOptions): GitHubProxy {
  const newId = o.newId ?? (() => randomUUID());
  return {
    async handle(authorization, body) {
      const parts = parseProxyToken(BEARER.exec(authorization ?? '')?.[1] ?? '');
      const user = parts ? o.user(parts.userId) : undefined;
      const job = parts && user?.holds(parts) ? user.job(parts.jobId) : undefined;
      if (!parts || !user || !job) {
        o.log('hopper: GitHub proxy: refused a request whose token is no job\'s');
        return { status: 401, body: { error: 'refused: the token is not a job\'s of this hopper. A job asks with its own HOPPER_TOKEN_FILE' } };
      }
      if (!AT_WORK.includes(job.status)) {
        o.log(`hopper: GitHub proxy: refused job ${job.id}: it is ${job.status}`);
        return { status: 401, body: { error: `refused: job ${job.id} is ${job.status}, not at work: only a running job asks the hopper` } };
      }
      const requestId = newId();
      const machine = user.machineOf(job);
      const hopper = o.hopper();
      const own = hopper?.user.id === user.id;
      // Who asked and from where stay in the hopper: the job's timeline, and the hopper's user's log for another user's job.
      const record = (type: 'github_proxy.done' | 'github_proxy.refused' | 'github_proxy.failed', data: Record<string, unknown>): void => {
        const at = { requestId, ...(machine ? { machine } : {}), own, ...data };
        user.record({ type, jobId: job.id, data: at });
        if (hopper && !own) hopper.user.record({ type, data: { ...at, forUser: user.id, job: job.id } });
      };
      const refuse = (status: number, reason: string, req?: Partial<ProxyRequest>): ProxyAnswer => {
        record('github_proxy.refused', { ...(req?.op ? { op: req.op } : {}), ...(req?.repo ? { repo: req.repo } : {}), reason });
        return { status, body: { error: `refused: ${reason}`, requestId } };
      };
      const parsed = proxyRequest.safeParse(body);
      if (!parsed.success) {
        const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
        const why = parsed.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ');
        return refuse(400, `not a request the hopper takes (${why}). sh "$HOPPER_GH" help`, { ...(typeof raw.op === 'string' ? { op: raw.op as ProxyRequest['op'] } : {}), ...(typeof raw.repo === 'string' ? { repo: raw.repo } : {}) });
      }
      const req = parsed.data;
      if (!hopper) return refuse(503, 'the hopper has no user yet, so no GitHub connection', req);
      const allowed = checkRequest(req, { jobId: job.id, own, ...(repoOf(job) ? { repo: repoOf(job)! } : {}) }, hopper.connection.jobRepositories());
      if (!allowed.ok) return refuse(403, allowed.reason, req);
      const api = hopper.connection.api();
      if ('problem' in api) return refuse(503, api.problem, req);
      const over = o.limiter.take(req.op, `${user.id}/${job.id}`, machine === undefined ? undefined : `${user.id}/${machine}`);
      if (over) return refuse(429, over, req);
      // An issue says the hopper filed it, for which job: never labelled or assigned, so a person triages it.
      const sent: ProxyRequest = req.op === 'issue.create' ? { ...req, body: `${req.body}${filedNote(job.id, requestId)}` } : req;
      try {
        const result = await api.perform(sent);
        record('github_proxy.done', { op: req.op, repo: req.repo, number: result.number, url: result.url });
        return { status: 200, body: { ok: true, op: req.op, repo: req.repo, requestId, ...result } };
      } catch (e) {
        const status = e instanceof ProxyGitHubError ? e.status : undefined;
        const error = (e as Error).message;
        record('github_proxy.failed', { op: req.op, repo: req.repo, error });
        return { status: 502, body: { error, ...(status ? { githubStatus: status } : {}), requestId } };
      }
    },
  };
}
