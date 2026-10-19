// A login's outcome, from the job that asked for it (issue #1110, design.md "Logins"): only the requester knows whether
// a login worked, so it says so, outside the UI session, on the hopper's own URL and behind the Host guard, like the
// skill broker (job-skill.ts).
//
//   POST /job/login   `Authorization: Bearer <the job's proxy token>`; `outcome` (completed or failed), `tool` (the
//                     login's; empty: the job's latest login) and, for failed, `reason`, as a form (what `hopper-login`
//                     sends, src/logins/script.ts) or JSON. Plain text back: `ok: …`, or `no: <reason>`.
//
// Only the job's own logins, only while it is at work: 401 the token is no job's, or its job ended; 400 a bad call; 404
// it has no such login. It changes no job, question, webhook or setting: it ends, completes or reopens the login, each an
// `auth.*` event.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LOGIN_OUTCOMES, TERMINAL_STATUSES } from '../domain/types.ts';
import { parseProxyToken } from '../github-proxy/token.ts';
import { LOGIN_PATH } from '../logins/script.ts';
import type { Tenants } from './tenants.ts';

const BEARER = /^Bearer\s+(\S+)$/i;
const words = (s: string): string[] => s.toLowerCase().split(/\s+/).filter(Boolean);
const sameTool = (a: string, b: string): boolean => words(a).join(' ') === words(b).join(' ');
/** Every word of `named` is a word of `tool`, or ends one of its paths (`mcp_auth.py` of `.agents/…/mcp_auth.py`). */
const holdsWords = (tool: string, named: string): boolean => {
  const have = words(tool).flatMap((w) => [w, w.slice(w.lastIndexOf('/') + 1)]);
  return words(named).every((w) => have.includes(w));
};
/** An empty field is a field left out: the script always sends all three. */
const optional = z.string().trim().max(1000).optional().transform((v) => (v ? v : undefined));
const body = z.object({ outcome: z.enum(LOGIN_OUTCOMES), tool: optional, reason: optional })
  .refine((b) => b.outcome === 'completed' || b.reason !== undefined, { message: 'a failed login needs its reason: --reason TEXT' });

export function jobLoginRoutes(app: FastifyInstance, o: { tenants: Tenants }): void {
  void app.register(async (scope) => {
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, raw, done) => {
      done(null, Object.fromEntries(new URLSearchParams(raw as string)));
    });
    scope.post(LOGIN_PATH, async (req, reply) => {
      const say = (status: number, text: string) => reply.code(status).type('text/plain; charset=utf-8').send(`${text}\n`);
      const parts = parseProxyToken(BEARER.exec(req.headers.authorization ?? '')?.[1] ?? '');
      const user = parts ? o.tenants.user(parts.userId) : undefined;
      const job = parts && user?.githubProxy.user.holds(parts) ? user.githubProxy.user.job(parts.jobId) : undefined;
      if (!user || !job || TERMINAL_STATUSES.includes(job.status)) return say(401, 'no: the token is not a running job\'s of this hopper');
      const b = body.safeParse(req.body ?? {});
      if (!b.success) return say(400, `no: ${b.error.issues.map((i) => i.message).join('; ')}`);
      const { outcome, tool, reason } = b.data;
      // Newest first: the job's latest login of that tool; else of a tool whose words hold the words named (issue #2144:
      // a job names a helper's command by its script, or with its words spaced otherwise).
      const logins = user.store.logins.list({ jobId: job.id });
      const login = tool === undefined ? logins[0] : logins.find((l) => sameTool(l.tool, tool)) ?? logins.find((l) => holdsWords(l.tool, tool));
      if (!login) return say(404, `no: job ${job.id} asked for no ${tool ? `${tool} ` : ''}login`);
      const r = user.logins.outcome(login.id, outcome === 'completed' ? { outcome } : { outcome, reason: reason! });
      if (!r.ok) return say(404, `no: ${r.message}`);
      const now = r.login.status === 'pending' ? 'open again: report its new code with HOPPER_AUTH_PENDING' : r.login.status;
      return say(200, `ok: the ${r.login.tool} login is ${now}`);
    });
  });
}
