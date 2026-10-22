// A running job's plans (issue #870, design.md "Infra plans: no apply without a plan"): outside the UI session, on the
// hopper's own URL and behind the Host guard, as a job's artifacts are (job-artifacts.ts). `Authorization: Bearer <the
// job's proxy token>`, honoured only while its job is at work.
//
//   POST /job/infra-plans          JSON: tool, asset (KIND/NAME), target, repo, ref, commit, pullRequest?, read?, text,
//                                  file? (the saved plan file, base64), json (terraform: `terraform show -json` of the
//                                  plan file, as a string): kept with its summary, 201, with its id
//   GET  /job/infra-plans/:id      the plan, with its approval; ?file=1: its saved plan file, the bytes as they were put
//   POST /job/infra-signals        JSON: signals (issue #871: what a read-only check found — drift, audit-log writes):
//                                  each judged by the out-of-band rule; the out-of-band ones kept, 200, with the counts
//
// Plain text back, or JSON when `Accept: application/json` asks for it; every no says why. It changes no job, question,
// webhook or setting: it records a plan, an event on the job's timeline. A job never approves one. A plan that waits for a
// person is said with where it shows and the wait line that the hopper wakes on its approval (issue #2205).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { failedChecks, PLAN_FILE_MAX, PLAN_JSON_MAX, PLAN_TEXT_MAX, type PlanInput } from '../domain/infra-plans.ts';
import type { Job, JobStatus } from '../domain/types.ts';
import { nameWithoutEmail } from '../domain/users.ts';
import { parseProxyToken } from '../github-proxy/token.ts';
import { isPlanRefusal } from '../infra-plans/service.ts';
import type { Signal } from '../domain/out-of-band.ts';
import { assetOf } from '../vault/mint.ts';
import type { TenantParts, Tenants } from './tenants.ts';

export const INFRA_PLAN_PATH = '/job/infra-plans';
export const INFRA_SIGNAL_PATH = '/job/infra-signals';
const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];
const BEARER = /^Bearer\s+(\S+)$/i;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** A body that holds the largest text and JSON, escaped, and the largest plan file in base64. */
const BODY_LIMIT = PLAN_TEXT_MAX * 2 + PLAN_JSON_MAX * 2 + Math.ceil(PLAN_FILE_MAX / 3) * 4 + 64 * 1024;
/** A report of signals: a check with more sends more than one. */
const SIGNAL_BODY_LIMIT = 16 * 1024 * 1024;

type Asker = { t: TenantParts; job: Job } | { status: number; text: string };

function askerOf(tenants: Tenants, authorization: string | undefined): Asker {
  const parts = parseProxyToken(BEARER.exec(authorization ?? '')?.[1] ?? '');
  const t = parts ? tenants.user(parts.userId) : undefined;
  const job = parts && t?.githubProxy.user.holds(parts) ? t.githubProxy.user.job(parts.jobId) : undefined;
  if (!parts || !t || !job) return { status: 401, text: 'the token is not a job\'s of this hopper. A job asks with its own HOPPER_TOKEN_FILE.' };
  if (!AT_WORK.includes(job.status)) return { status: 401, text: `job ${job.id} is ${job.status}, not at work: only a running job records a plan.` };
  return { t, job };
}

const answer = (req: FastifyRequest, reply: FastifyReply, status: number, json: Record<string, unknown>, text: string): FastifyReply =>
  (/\bapplication\/json\b/.test(req.headers.accept ?? '')
    ? reply.code(status).type('application/json; charset=utf-8').send(`${JSON.stringify({ ok: status < 400, ...json })}\n`)
    : reply.code(status).type('text/plain; charset=utf-8').send(`${text}\n`));
const no = (req: FastifyRequest, reply: FastifyReply, status: number, why: string): FastifyReply => answer(req, reply, status, { error: why }, `no: ${why}`);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The plan input and its file in a job's body, or why it is none. */
function inputOf(body: unknown): { input: PlanInput; file?: Buffer } | string {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const asset = assetOf(str(b.asset) ?? '');
  if (!asset) return 'asset must be KIND/NAME, as aws-role/123456789012/deploy: what an apply of the plan is minted a credential for';
  const [tool, target, repo, ref, commit, text] = ['tool', 'target', 'repo', 'ref', 'commit', 'text'].map((k) => str(b[k]));
  if (!tool || !target || !repo || !ref || !commit || text === undefined) return 'the plan names tool, asset, target, repo, ref, commit and text';
  if (b.pullRequest !== undefined && typeof b.pullRequest !== 'number') return 'pullRequest must be a pull request number';
  if (b.read !== undefined && typeof b.read !== 'string') return 'read must be the read profile the plan was made with: read/<kind>/<asset>';
  if (b.json !== undefined && typeof b.json !== 'string') return 'json must be terraform show -json of the plan file, as a string';
  let file: Buffer | undefined;
  if (b.file !== undefined) {
    if (typeof b.file !== 'string' || !BASE64.test(b.file) || b.file.length % 4 !== 0) return 'file must be the saved plan file in base64';
    file = Buffer.from(b.file, 'base64');
  }
  const input: PlanInput = {
    tool: tool as PlanInput['tool'], asset, target, repo, ref, commit, text,
    ...(typeof b.pullRequest === 'number' ? { pullRequest: b.pullRequest } : {}), ...(typeof b.read === 'string' ? { read: b.read } : {}),
    ...(typeof b.json === 'string' ? { json: b.json } : {}),
  };
  return { input, ...(file ? { file } : {}) };
}

export function jobInfraPlanRoutes(app: FastifyInstance, o: { tenants: Tenants }): void {
  void app.register(async (scope) => {
    // The text and the plan file in base64, whole: the limits are checked after.
    scope.post(INFRA_PLAN_PATH, { bodyLimit: BODY_LIMIT }, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(req, reply, who.status, who.text);
      const said = inputOf(req.body);
      if (typeof said === 'string') return no(req, reply, 400, said);
      const r = who.t.githubProxy.infraPlans.record(who.job, said.input, said.file);
      if (isPlanRefusal(r)) return no(req, reply, r.status, r.no);
      const { plan: p, view } = r;
      const failed = failedChecks(p);
      const next = failed ? `failed: ${failed}\nnext: nobody approves this plan; fix the code and plan again`
        : view.approval ? `approved by ${nameWithoutEmail(view.approval.by)} (auto-approve: ${view.approver.why})\nnext: ask with --plan ${p.id}`
          : `next: ${view.approver.who === 'admin' ? 'an admin' : 'an operator or an admin'} approves it (${view.approver.why}). It shows in Needs you, under Infra plans, and at the hopper's #infra/${p.id}.
wait: end your turn with HOPPER_WAITING and on: infra plan ${p.id}; the hopper wakes you when it is approved. Then ask with --plan ${p.id}`;
      return answer(req, reply, 201, { plan: view }, `recorded: plan ${p.id}  ${p.tool}  ${p.asset.kind}/${p.asset.name}  ${p.target}  stale at ${p.expiresAt}
summary: ${p.summary?.words ?? ''} (${p.summary?.level ?? ''} risk)
${next}`);
    });

    // Out-of-band changes (issue #871): the signals a job's read-only check found, judged by the hopper's one rule.
    scope.post(INFRA_SIGNAL_PATH, { bodyLimit: SIGNAL_BODY_LIMIT }, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(req, reply, who.status, who.text);
      const signals = (req.body as { signals?: unknown } | undefined)?.signals;
      if (!Array.isArray(signals) || !signals.every((s) => typeof s === 'object' && s !== null)) return no(req, reply, 400, 'signals must be a list of signals: source, key, target, what, who, at, detail');
      const r = who.t.githubProxy.outOfBand.report({ job: who.job.id, ...(who.job.source?.url ? { issue: who.job.source.url } : {}) }, signals as Signal[]);
      if (isPlanRefusal(r)) return no(req, reply, r.status, r.no);
      const recorded = r.recorded.map(({ detail: _detail, ...c }) => c);
      return answer(req, reply, 200, { recorded, inBand: r.inBand, known: r.known }, [
        `out of band: ${r.recorded.length} recorded, each on Infra and sent to the notifiers; in band: ${r.inBand.length}; reported before: ${r.known}`,
        ...r.recorded.map((c) => `recorded: ${c.id}  ${c.source}  ${c.target}  ${c.what}${c.who ? `  by ${c.who}` : ''}`),
        ...r.inBand.map((s) => `in band: ${s.source} ${s.key}: ${s.why}`),
      ].join('\n'));
    });

    scope.get<{ Params: { id: string } }>(`${INFRA_PLAN_PATH}/:id`, async (req, reply) => {
      const who = askerOf(o.tenants, req.headers.authorization);
      if ('status' in who) return no(req, reply, who.status, who.text);
      const plans = who.t.githubProxy.infraPlans;
      const plan = plans.get(req.params.id);
      if (!plan) return no(req, reply, 404, `no plan ${req.params.id}`);
      if ((req.query as Record<string, unknown> | undefined)?.file !== undefined) {
        const file = plans.file(plan.id);
        if (!file) return no(req, reply, 404, `plan ${plan.id} has no saved plan file`);
        return reply.code(200).type('application/octet-stream').header('cache-control', 'no-store').send(file);
      }
      const { text: _text, ...view } = (await plans.view(plan.id))!;
      return answer(req, reply, 200, { plan: view },
        `plan ${plan.id}  ${plan.tool}  ${plan.asset.kind}/${plan.asset.name}  ${plan.target}  ${view.approval ? `approved by ${nameWithoutEmail(view.approval.by)}` : `not approved: ${view.approver.who === 'nobody' ? 'nobody approves it' : `${view.approver.who === 'admin' ? 'an admin' : 'an operator or an admin'} approves it`} (${view.approver.why})`}  stale at ${plan.expiresAt}`);
    });
  });
}
