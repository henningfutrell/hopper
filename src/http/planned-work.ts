// Planned work's read (issue #2840, design.md "Planned work"): one work plan — an issue, its plan pieces and plan tasks
// from GitHub's sub-issues — with each plan task's jobs and where each stands, rolled up. Read-only, and made on each read
// from the issue graph and the job graph: nothing is kept, and no GitHub read is made. Its export answers the same work plan
// as CSV, one row per plan task, or as nested JSON with snake_case keys.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { planIssueUrls, plannedWork, type WorkPlan } from '../domain/planned-work.ts';
import { PLANNED_WORK_CSV_COLUMNS, plannedWorkCsv, plannedWorkJson } from '../domain/planned-work-export.ts';
import { HttpError, parseWith } from './errors.ts';
import { readJobGraph } from './job-graph-read.ts';
import type { Operation } from './openapi-operation.ts';
import type { TenantParts } from './tenants.ts';

const ISSUE_REF = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const ISSUE_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\/?$/;

export const plannedWorkQuery = z.object({
  issue: z.string().transform((s, ctx) => {
    const m = ISSUE_REF.exec(s.trim()) ?? ISSUE_URL.exec(s.trim());
    if (!m) { ctx.addIssue({ code: 'custom', message: 'issue: write owner/name#number or the issue\'s URL' }); return z.NEVER; }
    return { repo: m[1]!, number: Number(m[2]) };
  }),
});

export const plannedWorkExportQuery = plannedWorkQuery.extend({ format: z.enum(['csv', 'json']) });

export const PLANNED_WORK_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/planned-work', tag: 'Jobs', summary: 'A work plan, rolled up', description: 'One work plan (issue #2840): the issue `issue` names (`owner/name#number` or its URL), its **plan pieces** (its sub-issues on GitHub, and the required children its jobs filed) and their **plan tasks** (theirs; a plan piece with no sub-issues is its own one plan task, and an issue with no sub-issues a work plan of one plan piece, itself). Read from the issue graph, so an issue a GitHub source did not read yet is not in it. Each plan task has its `jobs` — the job graph\'s jobs of its issue and of the sub-issues under it, each with its `id`, `status`, `stage`, `stageText` and `pullRequest` —, read, never copied, so the stages are the Jobs view\'s; and `dependsOn`, the issues that block it (GitHub\'s issue dependencies). Each `status` is `planned`, `running`, `done` or `blocked`: a plan task\'s from its jobs — a failed job, or one that waits on a person, blocks it; done jobs make it done; any other job runs it; a job a later one took the place of, or a cancelled one, counts for nothing; with no job that counts it is `done` when its issue closed as completed, else `planned` —, a plan piece\'s and the work plan\'s from what is under them and their own jobs: a blocked part blocks it, only planned parts leave it planned, all done is done, and anything else runs it. `counts`: how many plan tasks are in each status. 400: `issue` is not an issue. 404: the issue graph and the lineage links know no such issue.', query: plannedWorkQuery, returns: '`WorkPlan` `{ id, repo, number, title, url, status, counts, jobs, pieces: [{ …, tasks: [{ …, dependsOn, jobs }], jobs }] }`', errors: [400, 404] },
  { method: 'get', path: '/api/planned-work/export', tag: 'Jobs', summary: 'A work plan, exported', description: `The work plan \`GET /api/planned-work\` answers for \`issue\` (issue #2840), as a file to save (\`content-disposition: attachment\`). \`format=csv\`: one row per plan task, with the columns ${PLANNED_WORK_CSV_COLUMNS.map((c) => `\`${c}\``).join(', ')}; \`job_ids\` and \`job_statuses\` are joined by \`|\`, a job's status is its stage as the Jobs view has it, \`artifact\` is its plan piece's artifact, and \`updated_at\` the newest of its issues' updates and its jobs' stage changes. A text cell a spreadsheet would read as a formula starts with a quote mark. \`format=json\`: the work plan nested, with snake_case keys: \`{ plan_id, title, status, url, counts, jobs, pieces: [{ piece_id, title, status, url, artifact, jobs, tasks: [{ task_id, title, status, url, depends_on, updated_at, jobs: [{ id, status }] }] }] }\`. Nothing leaves the hopper but this answer. 400: \`issue\` is not an issue, or \`format\` is not \`csv\` or \`json\`. 404: as \`GET /api/planned-work\`.`, query: plannedWorkExportQuery, returns: 'CSV (`text/csv`) or JSON', errors: [400, 404] },
];

/** The work plan whose root is `issue`, or a 404 when the issue graph and the lineage links know no such issue. */
function readPlan(t: TenantParts, issue: { repo: string; number: number }): WorkPlan {
  // The job graph with the newest job of each issue of the plan too, though it ended before the queue's window.
  let known = true;
  const { graph, issueGraph, links } = readJobGraph(t, (g, l) => {
    const urls = planIssueUrls(issue, g, l);
    known = urls !== undefined;
    return urls ?? [];
  });
  if (!known) throw new HttpError(404, `no issue ${issue.repo}#${issue.number} is known: a GitHub source reads an issue for the issue graph when it lists it`);
  return plannedWork({ root: issue, issueGraph, links, graph });
}

export function plannedWorkRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/planned-work', async (req) => readPlan(o.tenant(req), parseWith(plannedWorkQuery, req.query).issue));
  app.get('/api/planned-work/export', async (req, reply: FastifyReply) => {
    const { issue, format } = parseWith(plannedWorkExportQuery, req.query);
    const plan = readPlan(o.tenant(req), issue);
    const name = `planned-work-${issue.repo.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${issue.number}.${format}`;
    reply.header('content-disposition', `attachment; filename="${name}"`);
    if (format === 'json') return plannedWorkJson(plan);
    return reply.type('text/csv; charset=utf-8').send(plannedWorkCsv(plan));
  });
}
