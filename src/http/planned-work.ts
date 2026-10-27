// Planned work (issues #2840, #2861, design.md "Planned work"): the work plans the plan store keeps, each with its plan
// pieces and plan tasks, each plan task's jobs and where each stands, rolled up, and the plan artifacts. Reads come from
// the store and the job graph only, so a plan stays when its GitHub sync is off and no GitHub read is made. Import keeps a
// plan from an issue's sub-issue tree as the issue graph holds it; the plan sync does it again while its sync is `github`.
// Artifacts are records a person adds or removes, or a job's pull request the sync recorded. The export answers the same
// work plan as CSV, one row per plan task, or as nested JSON with snake_case keys. Nothing is written to GitHub.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock } from '../domain/ports.ts';
import { plannedWork, workPlanSummary, type WorkPlan, type WorkPlanSummary } from '../domain/planned-work.ts';
import { PLANNED_WORK_CSV_COLUMNS, plannedWorkCsv, plannedWorkJson } from '../domain/planned-work-export.ts';
import { PLAN_ARTIFACT_TYPES, PLAN_SYNCS, refOf, type KeptPlan, type PlanArtifact } from '../domain/work-plans.ts';
import { syncPlan } from '../engine/plan-sync.ts';
import { HttpError, parseWith } from './errors.ts';
import { readJobGraph } from './job-graph-read.ts';
import type { Operation } from './openapi-operation.ts';
import { signedInOf, type TenantParts } from './tenants.ts';
import { personOf } from './ui/sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const ISSUE_REF = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const ISSUE_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/;

/** An issue, as `owner/name#number` or its URL. */
const issueField = (name: string) => z.string().transform((s, ctx) => {
  const m = ISSUE_REF.exec(s.trim()) ?? ISSUE_URL.exec(s.trim());
  if (!m) { ctx.addIssue({ code: 'custom', message: `${name}: write owner/name#number or the issue's URL` }); return z.NEVER; }
  return { repo: m[1]!, number: Number(m[2]) };
});
/** A kept work plan's id: its issue's ref, the repository lowercase. */
const planField = issueField('plan').transform((i) => refOf(i.repo, i.number));
/** A plan piece's or a plan task's id in a plan: its issue's ref. */
const itemField = (name: string) => issueField(name).transform((i) => refOf(i.repo, i.number));

export const plannedWorkQuery = z.object({ plan: planField });
export const plannedWorkExportQuery = plannedWorkQuery.extend({ format: z.enum(['csv', 'json']) });
export const planImportBody = z.strictObject({ issue: issueField('issue'), sync: z.enum(PLAN_SYNCS).default('github') });
export const planSyncBody = z.strictObject({ plan: planField, sync: z.enum(PLAN_SYNCS).optional() });
export const planRemoveBody = z.strictObject({ plan: planField });
export const planArtifactBody = z.strictObject({
  plan: planField, piece: itemField('piece'), task: itemField('task').optional(), job: z.string().trim().min(1).max(200).optional(),
  type: z.enum(PLAN_ARTIFACT_TYPES),
  ref: z.string().trim().max(2000).refine((s) => /^https?:\/\/\S+$/.test(s) || /^[\w.-]{1,128}$/.test(s), 'ref: write a URL or a hopper artifact\'s id'),
});
export const planArtifactRemoveBody = z.strictObject({ plan: planField, id: z.string().min(1).max(200) });

const NOT_KEPT = (id: string) => new HttpError(404, `no work plan ${id} is kept: import it first (POST /ui/api/planned-work/import)`);
const NOT_KNOWN = (i: { repo: string; number: number }) =>
  new HttpError(404, `no issue ${i.repo}#${i.number} is known: a GitHub source reads an issue for the issue graph when it lists it`);

const PLAN_SHAPE = '`WorkPlan` `{ id, repo, number, title, url, status, sync, syncedAt, counts, jobs, pieces: [{ …, artifacts, tasks: [{ …, dependsOn, jobs, artifacts, updatedAt }], jobs }] }`';
export const PLANNED_WORK_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/planned-work/plans', tag: 'Jobs', summary: 'The kept work plans', description: 'Issue #2861: every work plan the plan store keeps, by id, each rolled up as `GET /api/planned-work` does, without its tree: `{ id, repo, number, title, url, status, sync, syncedAt, counts, pieces, tasks }` (`pieces`, `tasks`: how many).', returns: '`{ plans: WorkPlanSummary[] }`' },
  { method: 'get', path: '/api/planned-work', tag: 'Jobs', summary: 'A work plan, rolled up', description: 'One work plan the plan store keeps (issues #2840, #2861), named by `plan`: its issue as `owner/name#number` or its URL. Read from the store and the job graph only: the plan stays when its GitHub sync is off, and no GitHub read is made. Its **plan pieces** and their **plan tasks** in the store\'s order (a plan piece with no sub-issues is its own one plan task, and an issue with no sub-issues a work plan of one plan piece, itself). Each plan task has its `jobs` — the job graph\'s jobs of its issues (its own and the sub-issues under it) and the jobs the store links to it, each with its `id`, `status`, `stage`, `stageText` and `pullRequest` —, read, never copied, so the stages are the Jobs view\'s; `dependsOn`, the issues that block it; and `artifacts`, its **plan artifacts** (`{ id, type, ref, jobId, source, by, createdAt, updatedAt }`; a plan piece\'s own are on the plan piece). Each `status` is `planned`, `running`, `done` or `blocked`: a plan task\'s from its jobs — a failed job, or one that waits on a person, blocks it; done jobs make it done; any other job runs it; a job a later one took the place of, or a cancelled one, counts for nothing; with no job that counts it is `done` when each of its issues closed as completed at the last plan sync, or its item is done, else `planned` —, a plan piece\'s and the work plan\'s from what is under them and their own jobs: a blocked part blocks it, only planned parts leave it planned, all done is done, and anything else runs it. `counts`: how many plan tasks are in each status. 400: `plan` is not an issue. 404: the store keeps no such plan.', query: plannedWorkQuery, returns: PLAN_SHAPE, errors: [400, 404] },
  { method: 'get', path: '/api/planned-work/export', tag: 'Jobs', summary: 'A work plan, exported', description: `The work plan \`GET /api/planned-work\` answers for \`plan\` (issues #2840, #2861), as a file to save (\`content-disposition: attachment\`). \`format=csv\`: one row per plan task, with the columns ${PLANNED_WORK_CSV_COLUMNS.map((c) => `\`${c}\``).join(', ')}; \`job_ids\`, \`job_statuses\`, \`piece_artifacts\` and \`task_artifacts\` (the artifacts' refs) are joined by \`|\`, a job's status is its stage as the Jobs view has it, and \`updated_at\` the newest of its issues' updates and its jobs' stage changes. A text cell a spreadsheet would read as a formula starts with a quote mark. \`format=json\`: the work plan nested, with snake_case keys: \`{ plan_id, title, status, url, sync, synced_at, counts, jobs, pieces: [{ piece_id, title, status, url, artifacts, jobs, tasks: [{ task_id, title, status, url, depends_on, updated_at, artifacts, jobs: [{ id, status }] }] }] }\`, each artifact \`{ id, type, ref, job_id, source, by, created_at, updated_at }\`. \`hopper plan export\` prints the same. Nothing leaves the hopper but this answer. 400: \`plan\` is not an issue, or \`format\` is not \`csv\` or \`json\`. 404: as \`GET /api/planned-work\`.`, query: plannedWorkExportQuery, returns: 'CSV (`text/csv`) or JSON', errors: [400, 404] },
  { method: 'post', path: '/ui/api/planned-work/import', tag: 'Jobs', summary: 'Import a work plan', description: 'Issue #2861: keeps the work plan of `issue` (`owner/name#number` or its URL) in the plan store, from its sub-issue tree as the issue graph holds it — GitHub\'s sub-issues and the required children jobs filed —, links the newest job of each of its issues, and keeps each linked job\'s pull request as a `pull_request` artifact. `sync` (a new plan only; default `github`): `github`, the plan sync imports the tree again every 5 minutes; `off`, only the store has it. A kept plan is synced again and keeps its sync. Its artifacts and job links are kept, never removed. Nothing is read from or written to GitHub: the GitHub sources keep the issue graph. 400: a bad body. 404: the issue graph knows no such issue.', role: 'operator', body: planImportBody, returns: PLAN_SHAPE, errors: [400, 404] },
  { method: 'post', path: '/ui/api/planned-work/sync', tag: 'Jobs', summary: 'Sync a work plan, or set its sync', description: 'Issue #2861: sets a kept plan\'s `sync` (`github` or `off`) when given, and, when its sync is then `github`, imports its tree again from the issue graph now. With `off` the store keeps the tree as it is. 400: a bad body. 404: the store keeps no such plan. 409: its sync is `github` and the issue graph knows its issue no more: the store keeps the tree as it was.', role: 'operator', body: planSyncBody, returns: PLAN_SHAPE, errors: [400, 404, 409] },
  { method: 'post', path: '/ui/api/planned-work/remove', tag: 'Jobs', summary: 'Remove a work plan', description: 'Issue #2861: takes a work plan out of the plan store, with its job links and artifacts. Jobs and issues stay as they are. 404: the store keeps no such plan.', role: 'operator', body: planRemoveBody, returns: '`{ removed: true }`', errors: [400, 404] },
  { method: 'post', path: '/ui/api/planned-work/artifacts', tag: 'Jobs', summary: 'Add a plan artifact', description: 'Issue #2861: keeps a **plan artifact** — what a person judges a plan piece or a plan task by — as a record of the plan store: `type` (`pull_request`, `screenshot`, `report` or `link`), `ref` (a URL, or a hopper artifact\'s id), its plan `piece` and, for a plan task\'s, `task` (each its issue, `owner/name#number` or its URL), and the `job` it came from, if any. Kept with who added it and when. The same type and ref on the same piece and task again is answered the one kept. 400: a bad body, or a `task` that is not one of the piece\'s. 404: the store keeps no such plan, or the plan no such piece, or no such job.', role: 'operator', body: planArtifactBody, returns: '`PlanArtifact`', errors: [400, 404] },
  { method: 'post', path: '/ui/api/planned-work/artifacts/remove', tag: 'Jobs', summary: 'Remove a plan artifact', description: 'Issue #2861: takes one artifact, by its `id`, off a kept plan. 404: the plan holds no such artifact.', role: 'operator', body: planArtifactRemoveBody, returns: '`{ removed: true }`', errors: [400, 404] },
];

/** The kept plans rolled up, from one read of the job graph with every issue and linked job of theirs. */
function rollUp(t: TenantParts, plans: readonly KeptPlan[]): WorkPlan[] {
  const issueKeys = plans.flatMap((p) => [p.url, ...p.pieces.flatMap((x) => [x.url, ...x.tasks.flatMap((k) => k.issues.map((i) => i.url))])]);
  const jobIds = plans.flatMap((p) => p.jobLinks.map((l) => l.jobId));
  const { graph } = readJobGraph(t, { issueKeys, jobIds });
  return plans.map((plan) => plannedWork({ plan, artifacts: t.store.workPlans.artifacts(plan.id), graph }));
}

function readPlan(t: TenantParts, id: string): WorkPlan {
  const kept = t.store.workPlans.get(id);
  if (!kept) throw NOT_KEPT(id);
  return rollUp(t, [kept])[0]!;
}

export function registerPlannedWorkRoutes(app: FastifyInstance, o: { operator: Guard; tenant: (req: FastifyRequest) => TenantParts; clock: Clock }): void {
  app.get('/api/planned-work/plans', async (req): Promise<{ plans: WorkPlanSummary[] }> => {
    const t = o.tenant(req);
    return { plans: rollUp(t, t.store.workPlans.list()).map(workPlanSummary) };
  });
  app.get('/api/planned-work', async (req) => readPlan(o.tenant(req), parseWith(plannedWorkQuery, req.query).plan));
  app.get('/api/planned-work/export', async (req, reply: FastifyReply) => {
    const { plan: id, format } = parseWith(plannedWorkExportQuery, req.query);
    const plan = readPlan(o.tenant(req), id);
    const name = `planned-work-${id.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.${format}`;
    reply.header('content-disposition', `attachment; filename="${name}"`);
    if (format === 'json') return plannedWorkJson(plan);
    return reply.type('text/csv; charset=utf-8').send(plannedWorkCsv(plan));
  });

  app.post('/ui/api/planned-work/import', o.operator, async (req): Promise<WorkPlan> => {
    const { issue, sync } = parseWith(planImportBody, req.body);
    const t = o.tenant(req);
    const kept = syncPlan(t.store, issue, sync, o.clock.now());
    if (!kept) throw NOT_KNOWN(issue);
    return readPlan(t, kept.id);
  });
  app.post('/ui/api/planned-work/sync', o.operator, async (req): Promise<WorkPlan> => {
    const b = parseWith(planSyncBody, req.body);
    const t = o.tenant(req);
    const kept = t.store.workPlans.get(b.plan);
    if (!kept) throw NOT_KEPT(b.plan);
    if (b.sync) t.store.workPlans.setSync(kept.id, b.sync, o.clock.now().toISOString());
    if ((b.sync ?? kept.sync) === 'github' && !syncPlan(t.store, kept, 'github', o.clock.now())) {
      throw new HttpError(409, `the issue graph knows ${kept.id} no more: the plan store keeps its tree as it was`);
    }
    return readPlan(t, kept.id);
  });
  app.post('/ui/api/planned-work/remove', o.operator, async (req) => {
    const { plan } = parseWith(planRemoveBody, req.body);
    if (!o.tenant(req).store.workPlans.remove(plan)) throw NOT_KEPT(plan);
    return { removed: true };
  });
  app.post('/ui/api/planned-work/artifacts', o.operator, async (req): Promise<PlanArtifact> => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to add a plan artifact');
    const b = parseWith(planArtifactBody, req.body);
    const { store } = o.tenant(req);
    return store.tx(() => {
      const kept = store.workPlans.get(b.plan);
      if (!kept) throw NOT_KEPT(b.plan);
      const piece = kept.pieces.find((p) => p.id === b.piece);
      if (!piece) throw new HttpError(404, `work plan ${kept.id} has no plan piece ${b.piece}`);
      if (b.task && !piece.tasks.some((x) => x.id === b.task)) throw new HttpError(400, `task: ${b.task} is no plan task of plan piece ${piece.id}`);
      if (b.job && !store.jobs.get(b.job)) throw new HttpError(404, `job ${b.job} not found`);
      return store.workPlans.addArtifact({
        planId: kept.id, pieceId: piece.id, ...(b.task ? { taskId: b.task } : {}), ...(b.job ? { jobId: b.job } : {}), type: b.type, ref: b.ref, source: 'person', by: personOf(s),
      }, o.clock.now().toISOString());
    });
  });
  app.post('/ui/api/planned-work/artifacts/remove', o.operator, async (req) => {
    const b = parseWith(planArtifactRemoveBody, req.body);
    if (!o.tenant(req).store.workPlans.removeArtifact(b.plan, b.id)) throw new HttpError(404, `work plan ${b.plan} has no artifact ${b.id}`);
    return { removed: true };
  });
}
