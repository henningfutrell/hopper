// Grades (issue #2845, design.md "Grades"): GET /api/jobs/:id/grade, one job's automatic grade with its breakdown and its
// user grade with the history; GET /api/grades, the request's user's grades rolled up by executor, model, repository, work
// kind or machine; POST /ui/api/jobs/:id/grade, a person's user grade of an ended job, 1 to 5 with a note — each one kept,
// the newest the job's user grade. A grade changes no job: the hopper records it. GET /api/grades/settings and an admin's
// POST /ui/api/grades/settings: the weights, the revert window, the cost and time scales and grade-aware routing. Part 5,
// item grades: GET /api/grades/item?key=, one work item's grade over its jobs and its user grade; GET /api/grades/items, the
// items rolled up as the jobs are; POST /ui/api/grades/item, a person's user grade of an item that ended done or failed.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { gradeSettingsOf } from '../domain/grade-routing.ts';
import { disagreesOf, GRADE_GROUPS, GRADE_SIGNALS, gradedEnd, gradeRollup, type GradeSettings, type GradesView, type JobGradeView } from '../domain/grades.ts';
import { gradedItemState, type ItemGradesView, type ItemGradeView } from '../domain/item-grades.ts';
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
const itemKey = z.string().min(1).max(2000);
export const itemGradeQuery = z.object({ key: itemKey });
export const itemUserGradeBody = userGradeBody.extend({ key: itemKey });

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
  { method: 'get', path: '/api/grades/item', tag: 'Jobs', summary: 'A work item\'s grades', description: 'Issue #2845 part 5: the grade of a work item, by its source key (`key`, its issue\'s URL), over every job of it. `grade`: its `state` (`done` or `failed`) and when it entered it (`endedAt`), its newest job\'s keys, `jobs` (each graded job, oldest first, with its automatic `score`), its `facts` — its jobs\' facts summed: the outcome is the item\'s, the pull request the first one reverted, else the newest job\'s, the rest summed, the cost only when every job has one — and `auto`, graded as a job\'s is, with the same signals and weights. The grade pass grades an item at its next pass after it ended done or failed, and again when one of its jobs is graded again. Absent before that, and for an item that did not end done or failed. `user`, `history` and `disagree` as for a job. 400: no key. 404: no such work item.', query: itemGradeQuery, returns: '`ItemGradeView`', errors: [400, 404] },
  { method: 'get', path: '/api/grades/items', tag: 'Jobs', summary: 'Item grades rolled up by executor, model, repository, work kind or machine', description: 'Issue #2845 part 5: the graded work items summed per group, as `GET /api/grades` sums the jobs, each item by its newest job\'s keys. `by`, `repo` and `since` (items that ended at or after it) as there. Each group and `total`: `jobs` (how many items), `auto`, `userGraded`, `user`, `disagreements`. `items`: at most 200, the newest first, each with its `key`, `state`, keys, `jobs` (how many of its jobs are graded), `auto`, `user` and `disagree`. 400: a bad query.', query: gradesQuery, returns: '`ItemGradesView`', errors: [400] },
  { method: 'post', path: '/ui/api/grades/item', tag: 'Jobs', summary: 'Grade a work item', description: 'Issue #2845 part 5: a person\'s user grade of a work item that ended done or failed, by its source key: `key`, `score` 1 to 5 and an optional `note`. Kept as a job\'s user grade is: the newest is the item\'s, the older ones its history. It changes no job or item. 400: a bad body. 404: no such work item. 409: the item has not ended done or failed.', role: 'operator', body: itemUserGradeBody, returns: '`ItemGradeView`', errors: [400, 404, 409] },
  { method: 'post', path: '/ui/api/jobs/:id/grade', tag: 'Jobs', summary: 'Grade a job', description: 'Issue #2845: a person\'s user grade of a job that ended done or failed: `score` 1 to 5 and an optional `note`. Each one is kept, with who and when; the newest is the job\'s user grade, so a second one edits it and the first stays in its history. It changes no job. 400: a bad body. 404: no such job. 409: the job has not ended done or failed.', role: 'operator', body: userGradeBody, returns: '`JobGradeView`', errors: [400, 404, 409] },
];

function jobGradeView(store: UserStore, jobId: string): JobGradeView {
  const kept = store.grades.get(jobId);
  const history = store.grades.history(jobId);
  const user = history[0];
  const grade = kept ? (({ user: _, ...g }) => g)(kept) : undefined;
  return { jobId, ...(grade ? { grade } : {}), ...(user ? { user } : {}), history, ...(grade && user ? { disagree: disagreesOf(grade.auto.score, user.score) } : {}) };
}

function itemGradeView(store: UserStore, key: string): ItemGradeView {
  const kept = store.grades.getItem(key);
  const history = store.grades.itemHistory(key);
  const user = history[0];
  const grade = kept ? (({ user: _, ...g }) => g)(kept) : undefined;
  return { key, ...(grade ? { grade } : {}), ...(user ? { user } : {}), history, ...(grade && user ? { disagree: disagreesOf(grade.auto.score, user.score) } : {}) };
}

const sinceOf = (since: string | undefined): string | undefined => (since && since.length === 10 ? `${since}T00:00:00.000Z` : since);

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
    const since = sinceOf(q.since);
    const rows = store.grades.list({ ...(since ? { since } : {}), ...(q.repo ? { repo: q.repo } : {}) });
    const [all] = gradeRollup(rows.map((r) => ({ ...r, executor: 'all' })), 'executor');
    const total = all ? (({ key: _, ...t }) => t)(all) : { jobs: 0, auto: 0, userGraded: 0, disagreements: 0 };
    const jobs = rows.slice(0, JOBS).map((r) => ({
      jobId: r.jobId, endedAt: r.endedAt, executor: r.executor, ...(r.model ? { model: r.model } : {}), ...(r.repo ? { repo: r.repo } : {}), kind: r.kind,
      ...(r.machine ? { machine: r.machine } : {}), auto: r.auto.score, ...(r.user ? { user: r.user.score, disagree: disagreesOf(r.auto.score, r.user.score) } : {}),
    }));
    return { by: q.by, total, groups: gradeRollup(rows, q.by), jobs };
  });

  app.get('/api/grades/item', async (req): Promise<ItemGradeView> => {
    const { key } = parseWith(itemGradeQuery, req.query);
    const { store } = o.tenant(req);
    if (!store.workItems.get(key)) throw new HttpError(404, `work item ${key} not found`);
    return itemGradeView(store, key);
  });

  app.get('/api/grades/items', async (req): Promise<ItemGradesView> => {
    const q = parseWith(gradesQuery, req.query);
    const { store } = o.tenant(req);
    const since = sinceOf(q.since);
    const rows = store.grades.listItems({ ...(since ? { since } : {}), ...(q.repo ? { repo: q.repo } : {}) });
    const [all] = gradeRollup(rows.map((r) => ({ ...r, executor: 'all' })), 'executor');
    const total = all ? (({ key: _, ...t }) => t)(all) : { jobs: 0, auto: 0, userGraded: 0, disagreements: 0 };
    const items = rows.slice(0, JOBS).map((r) => ({
      key: r.key, endedAt: r.endedAt, state: r.state, executor: r.executor, ...(r.model ? { model: r.model } : {}), ...(r.repo ? { repo: r.repo } : {}), kind: r.kind,
      ...(r.machine ? { machine: r.machine } : {}), jobs: r.jobs.length, auto: r.auto.score,
      ...(r.user ? { user: r.user.score, disagree: disagreesOf(r.auto.score, r.user.score) } : {}),
    }));
    return { by: q.by, total, groups: gradeRollup(rows, q.by), items };
  });

  app.post('/ui/api/grades/item', o.operator, async (req): Promise<ItemGradeView> => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to grade a work item');
    const b = parseWith(itemUserGradeBody, req.body);
    const { store } = o.tenant(req);
    return store.tx(() => {
      const item = store.workItems.get(b.key);
      if (!item) throw new HttpError(404, `work item ${b.key} not found`);
      if (!gradedItemState(item.state)) throw new HttpError(409, `work item ${b.key} has not ended done or failed: there is nothing to grade yet`);
      store.grades.gradeItem(b.key, { score: b.score, ...(b.note ? { note: b.note } : {}), by: personOf(s), at: o.clock.now().toISOString() });
      return itemGradeView(store, b.key);
    });
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
