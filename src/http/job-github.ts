// The GitHub proxy's route (issue #563, design.md "GitHub through the hopper"): a running job — not a person —
// asks the hopper for a GitHub operation, outside the UI session, on the hopper's own URL and behind the Host
// guard, like a machine's join and dial-in (client-link.ts).
//
//   POST /job/github   `Authorization: Bearer <the job's proxy token>`; the request as a form (what `hopper-gh`
//                      sends, src/github-proxy/script.ts) or JSON. The hopper does it with its own GitHub
//                      connection, or answers why not. It changes no job, question, webhook or setting.
//
// The hopper acts with its oldest user's GitHub connection — the instance's first, as the plugin store reads
// the oldest user's (src/users/runtimes.ts). A job's bug report (issue #694) is the one exception: Report a bug's own
// path, with the job's own user's connection, so it is filed as that user.
import type { FastifyInstance } from 'fastify';
import { BugReportRefused, REPORT_REPO } from '../bug-reports/index.ts';
import type { Clock, Updater } from '../domain/ports.ts';
import { createGitHubProxy, createProxyLimiter, PROXY_PATH, REPORT_OP, type GitHubProxy, type ProxyAnswer, type ReportRequest } from '../github-proxy/index.ts';
import type { Tenants } from './tenants.ts';
import { bugReportsOf } from './ui/bug-reports.ts';

/** How a job reads similar open reports: what it can do next, in its own words. */
const similarText = (similar: { number: number; title: string; url: string }[]): string =>
  `similar open reports, so nothing was filed: ${similar.map((s) => `#${s.number} ${s.title} (${s.url})`).join('; ')}. `
  + `Add yours to one with --comment-on ${similar[0]!.number}, or file a new one with --force`;

/** A job's bug report, by the path a person's takes (src/bug-reports/), as the proxy answers it. */
async function reportForJob(o: { tenants: Tenants; updater: Pick<Updater, 'status'> }, userId: string, jobId: string, req: ReportRequest): Promise<ProxyAnswer> {
  const parts = o.tenants.user(userId);
  if (!parts) return { status: 401, body: { error: 'refused: the job\'s user is not on this hopper' } };
  try {
    const a = await bugReportsOf(parts, o.updater, (line) => console.warn(line)).fileForJob(jobId, {
      title: req.title, body: req.body, ...(req.commentOn !== undefined ? { commentOn: req.commentOn } : {}), ...(req.force ? { force: true } : {}),
    });
    if (a.kind === 'similar') return { status: 409, body: { error: similarText(a.similar), similar: a.similar } };
    return { status: 200, body: { ok: true, op: REPORT_OP, repo: REPORT_REPO, ...a } };
  } catch (e) {
    return { status: e instanceof BugReportRefused ? e.status : 500, body: { error: (e as Error).message } };
  }
}

export function jobGitHubRoutes(app: FastifyInstance, o: { tenants: Tenants; clock: Clock; updater: Pick<Updater, 'status'> }): GitHubProxy {
  const proxy = createGitHubProxy({
    user: (id) => o.tenants.user(id)?.githubProxy.user,
    hopper: () => {
      const oldest = o.tenants.list()[0];
      const parts = oldest ? o.tenants.user(oldest.id) : undefined;
      return parts ? { user: parts.githubProxy.user, connection: parts.githubProxy.connection } : undefined;
    },
    limiter: createProxyLimiter(o.clock),
    report: (user, job, req) => reportForJob(o, user.id, job.id, req),
    log: (line) => console.warn(line),
    now: () => o.clock.now().getTime(),
  });
  void app.register(async (scope) => {
    // What curl's --data-urlencode sends; only on this route.
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });
    scope.post(PROXY_PATH, async (req, reply) => {
      const answer = await proxy.handle(req.headers.authorization, req.body);
      return reply.code(answer.status).send(answer.body);
    });
  });
  return proxy;
}
