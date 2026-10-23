// A running job's push requirements (issue #2555, design.md "Push requirements"): the hopper plans and judges the checks a
// job runs in its work tree before it pushes, outside the UI session, on the hopper's own URL and behind the Host guard,
// like the topology read (job-topology.ts). `hopper-requirements` (src/github-proxy/requirements-script.ts) asks; the
// checks run on the job's machine, never here.
//
//   POST /job/requirements   `Authorization: Bearer <the job's proxy token>`; JSON, by `op`:
//     base     `{ repo, branch }`: the base the branch merges into, as the git proxy judges a push: `{ base }`.
//     plan     `{ repo, branch, base, head, files, requirementsFiles }` — the changed files against the base, and each
//              requirements file of the commit by its path: the dry run, `{ plan: { matched, skipped } }`. Runs nothing.
//     record   the same, and `runs` (each matched requirement's checks: exit code, measured values): the evaluation,
//              recorded on the job's timeline as `push_requirements.evaluated`: `{ passed, requirements }`.
//
// Only while the job is at work: 401 the token is no job's, or its job is not at work; 400 a bad call; 422 a requirements
// file it cannot read; 503 its user's GitHub cannot say the base. It changes no job, question, webhook or setting: the git
// proxy reads the evaluation at the push.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  effectiveRequirements, judgeEvaluation, parseRequirements, planPush, requirementsFileDir, type PushRequirement,
} from '../domain/push-requirements.ts';
import { workKindOf } from '../domain/skill-library.ts';
import type { JobStatus } from '../domain/types.ts';
import { baseBranchOf } from '../github-proxy/git-broker.ts';
import { parseProxyToken } from '../github-proxy/token.ts';
import { PUSH_REQUIREMENTS_EVALUATED } from '../users/push-requirements.ts';
import type { Tenants } from './tenants.ts';

export const JOB_REQUIREMENTS_PATH = '/job/requirements';
const AT_WORK: readonly JobStatus[] = ['running', 'waiting_answer', 'waiting_on'];
const BEARER = /^Bearer\s+(\S+)$/i;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** The changed files and requirements files of a big push fit; git's own push carries far more. */
const BODY_LIMIT = 16 * 1024 * 1024;

const repo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, { message: 'repo is owner/name' });
const branch = z.string().min(1).max(255);
const pushed = {
  repo, branch, base: branch, head: z.string().regex(SHA, { message: 'head is a commit id' }),
  files: z.array(z.string().min(1)).max(200_000), requirementsFiles: z.record(z.string(), z.string()),
};
const runs = z.array(z.strictObject({
  id: z.string(), checks: z.array(z.strictObject({ name: z.string(), exit: z.number().int(), measured: z.record(z.string(), z.number()).optional() })),
}));
const body = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('base'), repo, branch }),
  z.strictObject({ op: z.literal('plan'), ...pushed }),
  z.strictObject({ op: z.literal('record'), ...pushed, runs }),
]);

/** The requirements of the commit, by level; or the file that cannot be read, and why. */
function requirementsOf(files: Record<string, string>): { repo: PushRequirement[]; scoped: { dir: string; requirements: PushRequirement[] }[] } | { problem: string } {
  const at = { repo: [] as PushRequirement[], scoped: [] as { dir: string; requirements: PushRequirement[] }[] };
  for (const [path, text] of Object.entries(files)) {
    const dir = requirementsFileDir(path);
    if (dir === undefined) return { problem: `${path} is no requirements file` };
    const read = parseRequirements(text);
    if (!read.ok) return { problem: `${path}: ${read.problem}` };
    if (dir === '') at.repo = read.requirements;
    else at.scoped.push({ dir, requirements: read.requirements });
  }
  return at;
}

export function jobRequirementsRoutes(app: FastifyInstance, o: { tenants: Tenants }): void {
  app.post(JOB_REQUIREMENTS_PATH, { bodyLimit: BODY_LIMIT }, async (req, reply) => {
    const say = (status: number, text: string) => reply.code(status).type('text/plain; charset=utf-8').send(`${text}\n`);
    const parts = parseProxyToken(BEARER.exec(req.headers.authorization ?? '')?.[1] ?? '');
    const t = parts ? o.tenants.user(parts.userId) : undefined;
    const job = parts && t?.githubProxy.user.holds(parts) ? t.githubProxy.user.job(parts.jobId) : undefined;
    if (!t || !job) return say(401, 'no: the token is not a job\'s of this hopper. A job asks with its own HOPPER_TOKEN_FILE.');
    if (!AT_WORK.includes(job.status)) return say(401, `no: job ${job.id} is ${job.status}, not at work: only a job at work checks its push.`);
    const b = body.safeParse(req.body ?? {});
    if (!b.success) return say(400, `no: ${b.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`);
    const call = b.data;
    if (call.op === 'base') {
      const side = t.githubProxy.git;
      const git = side.git(call.repo);
      if ('problem' in git) return say(503, `no: ${git.problem}`);
      try {
        const facts = await git.repo(call.repo);
        return reply.send({ base: await baseBranchOf(side, git, call.repo, call.branch, facts.defaultBranch) });
      } catch (e) {
        return say(503, `no: ${call.repo} could not be read: ${(e as Error).message}`);
      }
    }
    const at = requirementsOf(call.requirementsFiles);
    if ('problem' in at) return say(422, `no: ${at.problem}`);
    // The hopper's defaults (Settings → Push requirements) below the commit's own; the job's override is not set anywhere yet.
    const plan = planPush(effectiveRequirements({ defaults: t.store.settings.getPushRequirementDefaults(), ...at }), {
      files: call.files, repo: call.repo, branch: call.branch, base: call.base, kind: workKindOf(job.spec), labels: job.source?.labels ?? [],
    });
    if (call.op === 'plan') return reply.send({ plan });
    const judged = judgeEvaluation(plan, call.runs);
    t.store.events.append({
      type: PUSH_REQUIREMENTS_EVALUATED, jobId: job.id,
      data: { repo: call.repo, branch: call.branch, base: call.base, head: call.head, passed: judged.passed, requirements: judged.requirements },
    });
    return reply.send(judged);
  });
}
