// The GitHub proxy's route (issue #563, design.md "GitHub through the hopper"): a running job — not a person —
// asks the hopper for a GitHub operation, outside the UI session, on the hopper's own URL and behind the Host
// guard, like a machine's join and dial-in (client-link.ts).
//
//   POST /job/github   `Authorization: Bearer <the job's proxy token>`; the request as a form (what `hopper-gh`
//                      sends, src/github-proxy/script.ts) or JSON. The hopper does it with the GitHub connection
//                      of the job's own user, or answers why not. It changes no job, question, webhook or setting.
//
// The hopper acts with the job's own user's GitHub connection (issue #1380), never another user's; a job's bug report
// (issue #694) too, by Report a bug's own path.
//
// A wait on a pull request's checks (`pr wait`, issue #1072 part 2) answers 202 while the checks of a pull request the
// hopper follows run: the watch it opens is on the job's stream (job-stream.ts), ended when the hopper sees them end.
import type { FastifyInstance } from 'fastify';
import { BugReportRefused, PUBLIC_REPORT_WARNING, REPORT_REPO } from '../bug-reports/index.ts';
import type { Clock } from '../domain/ports.ts';
import { createGitHubProxy, createPrWaits, createProxyLimiter, PROXY_PATH, REPORT_OP, type GitHubProxy, type PrWaits, type ProxyAnswer, type ReportRequest } from '../github-proxy/index.ts';
import type { Tenants } from './tenants.ts';
import { bugReportsOf } from './ui/bug-reports.ts';

/** A job's bug report, by the path a person's takes (src/bug-reports/), as the proxy answers it. */
async function reportForJob(o: { tenants: Tenants }, userId: string, jobId: string, req: ReportRequest): Promise<ProxyAnswer> {
  const parts = o.tenants.user(userId);
  if (!parts) return { status: 401, body: { error: 'refused: the job\'s user is not on this hopper' } };
  try {
    const a = await bugReportsOf(parts, (line) => console.warn(line)).fileForJob(jobId, {
      title: req.title, body: req.body, ...(req.commentOn !== undefined ? { commentOn: req.commentOn } : {}), ...(req.key !== undefined ? { key: req.key } : {}),
    });
    return { status: 200, body: { ok: true, op: REPORT_OP, repo: REPORT_REPO, ...a, warning: PUBLIC_REPORT_WARNING } };
  } catch (e) {
    return { status: e instanceof BugReportRefused ? e.status : 500, body: { error: (e as Error).message, warning: PUBLIC_REPORT_WARNING } };
  }
}

/** `pr wait`'s watches, over each user's job stream and records; an answer ends the job's own wait (HOPPER_WAITING). */
function prWaitsOf(tenants: Tenants): PrWaits {
  return createPrWaits({
    user(id) {
      const parts = tenants.user(id);
      const pullRequest = parts?.githubProxy.user.pullRequest;
      if (!parts || !pullRequest) return undefined;
      return {
        stream: parts.jobStream, events: parts.store.events, pullRequest,
        endWait(jobId, answer) {
          if (parts.store.jobs.get(jobId)?.status !== 'waiting_on') return;
          try {
            parts.engine.endWait(jobId, answer, 'hopper');
          } catch (e) {
            // Its agent went on by itself meanwhile: nothing waits any more.
            console.warn(`hopper: GitHub proxy: ending the wait of job ${jobId} failed: ${(e as Error).message}`);
          }
        },
      };
    },
    log: (line) => console.warn(line),
  });
}

/** The routes; the proxy, and `pr wait`'s watches, for the job stream's route to answer again when a job subscribes. */
export function jobGitHubRoutes(app: FastifyInstance, o: { tenants: Tenants; clock: Clock }): { proxy: GitHubProxy; prWaits: PrWaits } {
  const prWaits = prWaitsOf(o.tenants);
  const proxy = createGitHubProxy({
    user: (id) => o.tenants.user(id)?.githubProxy.user,
    connection: (id) => o.tenants.user(id)?.githubProxy.connection,
    limiter: createProxyLimiter(o.clock),
    report: (user, job, req) => reportForJob(o, user.id, job.id, req),
    log: (line) => console.warn(line),
    now: () => o.clock.now().getTime(),
    wait: (user, jobId, pr, seconds) => prWaits.open(user.id, jobId, pr, seconds),
    // A job on a wait for its own command that polls (issue #1210): the engine types the wait, or ends it after an hour.
    polled: (user, job, poll) => { o.tenants.user(user.id)?.engine.pollSeen(job.id, poll.on, poll.answer); },
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
  return { proxy, prWaits };
}
