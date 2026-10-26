// Planned work's read (issue #2840, design.md "Planned work"): one work plan — an issue, its plan pieces and plan tasks
// from GitHub's sub-issues — with each plan task's jobs and where each stands, rolled up. Read-only, and made on each read
// from the issue graph and the job graph: nothing is kept, and no GitHub read is made.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { planIssueUrls, plannedWork } from '../domain/planned-work.ts';
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

export const PLANNED_WORK_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/planned-work', tag: 'Jobs', summary: 'A work plan, rolled up', description: 'One work plan (issue #2840): the issue `issue` names (`owner/name#number` or its URL), its **plan pieces** (its sub-issues on GitHub, and the required children its jobs filed) and their **plan tasks** (theirs; a plan piece with no sub-issues is its own one plan task, and an issue with no sub-issues a work plan of one plan piece, itself). Read from the issue graph, so an issue a GitHub source did not read yet is not in it. Each plan task has its `jobs` — the job graph\'s jobs of its issue and of the sub-issues under it, each with its `id`, `status`, `stage`, `stageText` and `pullRequest` —, read, never copied, so the stages are the Jobs view\'s; and `dependsOn`, the issues that block it (GitHub\'s issue dependencies). Each `status` is `planned`, `running`, `done` or `blocked`: a plan task\'s from its jobs — a failed job, or one that waits on a person, blocks it; done jobs make it done; any other job runs it; a job a later one took the place of, or a cancelled one, counts for nothing; with no job that counts it is `done` when its issue closed as completed, else `planned` —, a plan piece\'s and the work plan\'s from what is under them and their own jobs: a blocked part blocks it, only planned parts leave it planned, all done is done, and anything else runs it. `counts`: how many plan tasks are in each status. 400: `issue` is not an issue. 404: the issue graph and the lineage links know no such issue.', query: plannedWorkQuery, returns: '`WorkPlan` `{ id, repo, number, title, url, status, counts, jobs, pieces: [{ …, tasks: [{ …, dependsOn, jobs }], jobs }] }`', errors: [400, 404] },
];

export function plannedWorkRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/planned-work', async (req) => {
    const { issue } = parseWith(plannedWorkQuery, req.query);
    // The job graph with the newest job of each issue of the plan too, though it ended before the queue's window.
    let known = true;
    const { graph, issueGraph, links } = readJobGraph(o.tenant(req), (g, l) => {
      const urls = planIssueUrls(issue, g, l);
      known = urls !== undefined;
      return urls ?? [];
    });
    if (!known) throw new HttpError(404, `no issue ${issue.repo}#${issue.number} is known: a GitHub source reads an issue for the issue graph when it lists it`);
    return plannedWork({ root: issue, issueGraph, links, graph });
  });
}
