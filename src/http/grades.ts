// Grades (issue #2845, design.md "Grades"): GET /api/jobs/:id/grade, one job's automatic grade with its breakdown and its
// user grade with the history; GET /api/grades, the request's user's grades rolled up by executor, model, repository, work
// kind or machine; POST /ui/api/jobs/:id/grade, a person's user grade of an ended job, 1 to 5 with a note — each one kept,
// the newest the job's user grade. A grade changes no job: the hopper records it. GET /api/grades/settings and an admin's
// POST /ui/api/grades/settings: the weights, the revert window, the cost and time scales and grade-aware routing.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { gradeSettingsOf } from '../domain/grade-routing.ts';
import { disagreesOf, GRADE_GROUPS, GRADE_SIGNALS, gradedEnd, gradeRollup, type GradeSettings, type GradesView, type JobGradeView } from '../domain/grades.ts';
import type { Clock } from '../domain/ports.ts';
import type { UserStore } from '../domain/store.ts';
import { HttpError, parseWith } from './errors.ts';
import type { Operation } from './openapi-operation.ts';
import { signedInOf, type TenantParts } from './tenants.ts';
import { personOf } from './ui/sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** How many jobs the rollup lists. */
const JOBS = 200;

export const gradesQuery = z.object({
  by: z.enum(GRADE_GROUPS).default('executor'),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional(),
  since: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
});

export const userGradeBody = z.strictObject({ score: z.number().int().min(1).max(5), note: z.string().trim().min(1).max(1000).optional() });

const weight = z.number().min(0).max(100);
export const gradeSettingsBody = z.strictObject({
  weights: z.strictObject(Object.fromEntries(GRADE_SIGNALS.map((g) => [g, weight.optional()])) as Record<(typeof GRADE_SIGNALS)[number], z.ZodOptional<typeof weight>>).optional(),
  revertWindowDays: z.number().int().min(1).max(90).optional(),
  costScaleUsd: z.number().positive().max(10_000).optional(),
  timeScaleMinutes: z.number().int().min(1).max(10_080).optional(),
  routing: z.strictObject({ on: z.boolean().optional(), minSamples: z.number().int().min(1).max(10_000).optional() }).optional(),
});

export const GRADE_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/jobs/:id/grade', tag: 'Jobs', summary: 'A job\'s grades', description: 'Issue #2845: the job\'s automatic grade and its user grade. `grade`: its keys (`executor`; `model`, the costliest in its token ledger; `repo`; `kind`, its work kind; `machine`), its `facts` and `auto` — `score` (0 to 100, the weighted mean of its signals) and `lines`, one per signal it has facts for (`outcome`, `checks`, `pull_request`, `rework`, `cost`, `time`), each with its `value` (0 to 1), `weight` and `why`. The grade pass grades a job a minute after it ended done or failed, and again when its pull request merged or closed, its item needed rework or ran again, or a landing batch reverted its pull request within the revert window (7 days). Absent before that, and for a job that did not end done or failed. `user`: the newest user grade (`score` 1 to 5, `note`, `by`, `at`); `history`: every one, newest first; `disagree`: the two are 40 points or more apart (a user grade of 1 is 0, of 5 is 100). 404: no such job.', returns: '`JobGradeView`', errors: [404] },
  { method: 'get', path: '/api/grades', tag: 'Jobs', summary: 'Grades rolled up by executor, model, repository, work kind or machine', description: 'Issue #2845: the request\'s user\'s graded jobs summed per group, the best mean automatic grade first. `by`: `executor` (default), `model`, `repo`, `kind` or `machine`; a group a job cannot name is `(none)`. Filters: `repo` (`owner/name`), `since` (a date or a time: jobs that ended at or after it). Each group: `jobs`, `auto` (the mean automatic grade), `userGraded` (how many a person graded), `user` (their mean user grade, 1 to 5) and `disagreements`. `total`: the same over every job the filters keep. `jobs`: at most 200, the newest first, each with its keys, `auto`, `user` and `disagree`. 400: a bad query.', query: gradesQuery, returns: '`GradesView`', errors: [400] },
  { method: 'get', path: '/api/grades/settings', tag: 'Jobs', summary: 'The grade settings', description: 'Issue #2845: how the automatic grade weighs its signals and what grade-aware routing does. `weights`: one per signal (`outcome`, `checks`, `pull_request`, `rework`, `cost`, `time`; 0 leaves it out). `revertWindowDays`: a revert this long after the merge or sooner lowers the grade (7). `costScaleUsd`, `timeScaleMinutes`: the estimated cost and the wall time that give half the cost and time signal ($5, 120 min). `routing`: `on` (off by default) — intake gives a new job the configured executor whose graded jobs of the same repository and work kind, else of the same work kind, did best —, and `minSamples` (10), the graded jobs each executor needs there before they are compared.', returns: '`GradeSettings`' },
  { method: 'post', path: '/ui/api/grades/settings', tag: 'Jobs', summary: 'Change the grade settings', description: 'Issue #2845: an admin changes the grade settings; the fields given change, the rest stay (a weight on its own). A change of the weights, the revert window or a scale grades the kept grades of the last 90 days again at the next grade pass. Grade routing applies to jobs that intake makes or that wait unstarted after it; a routing rule that sets the executor wins. 400: a bad body.', role: 'admin', body: gradeSettingsBody, returns: '`GradeSettings`', errors: [400] },
  { method: 'post', path: '/ui/api/jobs/:id/grade', tag: 'Jobs', summary: 'Grade a job', description: 'Issue #2845: a person\'s user grade of a job that ended done or failed: `score` 1 to 5 and an optional `note`. Each one is kept, with who and when; the newest is the job\'s user grade, so a second one edits it and the first stays in its history. It changes no job. 400: a bad body. 404: no such job. 409: the job has not ended done or failed.', role: 'operator', body: userGradeBody, returns: '`JobGradeView`', errors: [400, 404, 409] },
];

function jobGradeView(store: UserStore, jobId: string): JobGradeView {
  const kept = store.grades.get(jobId);
  const history = store.grades.history(jobId);
  const user = history[0];
  const grade = kept ? (({ user: _, ...g }) => g)(kept) : undefined;
  return { jobId, ...(grade ? { grade } : {}), ...(user ? { user } : {}), history, ...(grade && user ? { disagree: disagreesOf(grade.auto.score, user.score) } : {}) };
}

export function registerGradeRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts; clock: Clock }): void {
  app.get('/api/grades/settings', async (req): Promise<GradeSettings> => o.tenant(req).store.settings.getGradeSettings());

  app.post('/ui/api/grades/settings', o.admin, async (req): Promise<GradeSettings> => {
    const b = parseWith(gradeSettingsBody, req.body);
    const { store } = o.tenant(req);
    return store.tx(() => {
      const s = gradeSettingsOf(b, store.settings.getGradeSettings());
      store.settings.setGradeSettings(s);
      return s;
    });
  });

  app.get('/api/jobs/:id/grade', async (req): Promise<JobGradeView> => {
    const { id } = parseWith(z.object({ id: z.string() }), req.params);
    const { store } = o.tenant(req);
    if (!store.jobs.get(id)) throw new HttpError(404, `job ${id} not found`);
    return jobGradeView(store, id);
  });

  app.get('/api/grades', async (req): Promise<GradesView> => {
    const q = parseWith(gradesQuery, req.query);
    const { store } = o.tenant(req);
    const since = q.since && q.since.length === 10 ? `${q.since}T00:00:00.000Z` : q.since;
    const rows = store.grades.list({ ...(since ? { since } : {}), ...(q.repo ? { repo: q.repo } : {}) });
    const [all] = gradeRollup(rows.map((r) => ({ ...r, executor: 'all' })), 'executor');
    const total = all ? (({ key: _, ...t }) => t)(all) : { jobs: 0, auto: 0, userGraded: 0, disagreements: 0 };
    const jobs = rows.slice(0, JOBS).map((r) => ({
      jobId: r.jobId, endedAt: r.endedAt, executor: r.executor, ...(r.model ? { model: r.model } : {}), ...(r.repo ? { repo: r.repo } : {}), kind: r.kind,
      ...(r.machine ? { machine: r.machine } : {}), auto: r.auto.score, ...(r.user ? { user: r.user.score, disagree: disagreesOf(r.auto.score, r.user.score) } : {}),
    }));
    return { by: q.by, total, groups: gradeRollup(rows, q.by), jobs };
  });

  app.post('/ui/api/jobs/:id/grade', o.operator, async (req): Promise<JobGradeView> => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to grade a job');
    const { id } = parseWith(z.object({ id: z.string() }), req.params);
    const b = parseWith(userGradeBody, req.body);
    const { store } = o.tenant(req);
    return store.tx(() => {
      const job = store.jobs.get(id);
      if (!job) throw new HttpError(404, `job ${id} not found`);
      if (!gradedEnd(job.status)) throw new HttpError(409, `job ${id} has not ended done or failed: there is nothing to grade yet`);
      store.grades.grade(id, { score: b.score, ...(b.note ? { note: b.note } : {}), by: personOf(s), at: o.clock.now().toISOString() });
      return jobGradeView(store, id);
    });
  });
}
