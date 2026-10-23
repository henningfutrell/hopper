import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { failureSettingsOf } from '../domain/failures.ts';
import { jobBrake } from '../domain/intake-strictness.ts';
import { jobBom } from '../domain/job-bom.ts';
import { jobIdStarting } from '../domain/job-id-start.ts';
import { jobGraph, type JobGraphLink } from '../domain/job-graph.ts';
import type { WorkItem } from '../domain/work-items.ts';
import { awaitsBatch } from '../domain/work-item-landing.ts';
import { awaitingBatchKeys } from '../sources/intake-live.ts';
import { TERMINAL_STATUSES, withPhase, type Job, type JobStatus } from '../domain/types.ts';
import { HttpError, parseWith } from './errors.ts';
import type { Operation } from './openapi-operation.ts';
import type { TenantParts } from './tenants.ts';

// The work-item ledger's read sits beside the jobs' in the API reference (issue #1067).
export { WORK_ITEM_OPERATIONS } from './work-items.ts';

const STATUSES = [
  'queued', 'held', 'claimed', 'running', 'waiting_answer', 'operator_led', 'parked', 'waiting_on', 'finished', 'failed', 'cancelled', 'rejected',
] as const satisfies JobStatus[];

export const jobsQuery = z.object({
  status: z.string().optional().transform((s, ctx) => {
    if (!s) return undefined;
    const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
    for (const p of parts) {
      if (!(STATUSES as readonly string[]).includes(p)) ctx.addIssue({ code: 'custom', message: `unknown status ${p}` });
    }
    return parts as JobStatus[];
  }),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

const idParams = z.object({ id: z.string() });

/** The API reference's entry for the job graph (issue #900). */
export const JOB_GRAPH_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/jobs/graph', tag: 'Jobs', summary: 'The job graph', description: 'Where every job stands and how the jobs hang together (issue #900): nodes (jobs, issues, pull requests), each with its stage — `queued`, `running`, `waiting`, `pr_open`, `partly_done`, `done`, `failed`, `cancelled`, `superseded` (a failed or cancelled job a later job of its issue, its issue\'s close, a merge or a dismissal took the place of: no failure, issue #1036) — each job\'s failure, and each issue\'s stage, as the work-item ledger has its item (issue #1067: a failed job is `failed` only while its item is, `waiting` with `handedOff` while its item is handed to a person on it) —, or, for an issue no job here works, its own state first (issue #1895: closed as completed `done`, closed as not planned or as a duplicate `cancelled` with `closed`), then its item\'s, else `no_job` —, `done` with `awaitsBatch` for an issue that waits on its batch (issue #1337: merged into the landing branch, its batch run closes it), a job\'s task count, lane, machine, time in stage (`stageSince`) and pull request with its checks; a partly done job names the pull request that blocks the rest and what runs after its merge. Typed edges: `parent`, `follow_up`, `works`, `next_part`, `rerun`, `spawned`, `plan_apply`, `opened`, `waits_on_merge`, `closes`, `blocked_by` (an issue to an issue that blocks it), `stacked_on` (a pull request to the open one whose head branch is its base), `asks` (a job to its open question) and `hands_off` (a job to its open hand-off): an open question or hand-off is a node too, at `waiting`. `trees`: each group of connected nodes with its root and the nodes that block it (`blocking`). `stages`: how many jobs are in each stage. In plain words (issue #935): a node\'s `label` is its title, its repository and number apart; `stageText` says where it stands (`Building it (attempt 2 of 3)`, `PR open: checks running`, `Waiting on you: approve the plan`); `waitsOnYou` marks what waits on the person; a job\'s `phase`, `attempt` and `attempts`; each tree\'s `summary` is one line. The jobs are those `/api/queue` holds, the jobs whose pull request is open, the jobs with an open question or hand-off, the newest job of each of their issues, and the jobs these ran again, forked from or carried out. The Jobs view\'s graph and list.', returns: '`JobGraph` `{ nodes: JobGraphNode[], edges: JobGraphEdge[], trees: JobTree[], stages }`' },
  // A job's parts list (issue #935).
  { method: 'get', path: '/api/jobs/:id/bom', tag: 'Jobs', summary: 'A job\'s parts list', description: 'Everything one job touched or made (issue #935), grouped: `asked` (its issue, follow-ups it filed, rework asked), `work` (each run, its task list, lane, time, its usage — the share of each usage limit its runs burned and what they used of the machine —, the jobs that ran it again), `code` (its pull request, checks, branch, every commit, the files it changes, each push, its place in the merge order, merge), `outputs` (artifacts and their revisions, its plan or research report, the help pages and What\'s new lines its pull request changes), `infra` (plans and their approvals, minted credentials, drift, vault grants asked), `decisions` (questions and who answered them, overrides, its hand-off) and `machines` (the machines it ran on, Windows steps, and its resource ledger, issue #2504: a part `cleanup` whose status and label say its cleanup status, and one part per entry, kind `scratch_dir`, `job_worktree`, `job_scope`, `container_runtime`, `job_processes` or `job_containers`, its locator and state in `detail`, `failed` when its removal failed; issue #2498: a part `resources` with what its scope used, read at each reap, and while it runs one part `resources-now:<machine>` per machine whose last reading has its scope, status `running`: its memory now, its peak, its CPU cores busy, its CPU time so far and its OOM kills). Each part has its `status` — `waiting_on_you`, `running`, `open`, `done`, `failed`, `cancelled` or `recorded` — and its page (`href`, in the UI) or `url` (on GitHub); what waits on the person comes first. `header`: what was asked, where it stands and what is next, in plain words; `summary`: one line. `events`: the job\'s newest events, newest first. 404: no such job. The job page.', returns: '`JobBom` `{ jobId, header, summary, parts: BomPart[], events }`' },
  // A job's trust stamp (issue #655 part 10).
  { method: 'get', path: '/api/jobs/:id/stamp', tag: 'Jobs', summary: 'A job\'s trust stamp', description: 'What the job\'s trust stamp says and does (issue #655, design.md "Trust stamps"), by its id or its short id. `stamp`: the stamp as kept — `level`, `reasons`, `by`, `at`, `was` (a quarantined job\'s level before), `check` (Jev\'s trust check) — never its MAC; null: none. `verifies`: `yes`, `no` (the job or its stamp changed outside the hopper), `missing`, or `unknown` (the hopper has no stamp key). `level`: the level as verified, else null. `brake`: the intake strictness on the job — `strictness`, the level it `needs` to start, and where it was set (`at`). `startHold`: why the stamp holds the job\'s start, else null. `gate2`: `auto` (its sandbox requests may be approved with no person) or `person`. `doorsOpen`: whether its proxy token opens the hopper\'s doors. `checkDue`: whether Jev\'s trust check is due. `originActs` (part 14): who wrote, labelled and assigned its item — `role`, `login`, `id`, `app`, `trusted` — as read when its origin was judged; null: none kept. `visibility` (part 19): its repository\'s visibility — `public`, `private`, `internal` —; `linkedPulls`: the pull requests its item\'s text names — `url`, `author`, `fork`, `trusted`, `unread` —; each as read when its origin was judged, null: none kept. Read only.', returns: '`StampView` `{ jobId, stamp, verifies, level, brake, startHold, gate2, doorsOpen, checkDue, originActs, visibility, linkedPulls }`', errors: [404, 409] },
];

/** The job graph's bounds: followed jobs read, steps back along a job's origins, lineage links read. */
const GRAPH_FOLLOWED = 500;
const GRAPH_STEPS = 5;
const GRAPH_LINKS = 5000;
/** A parts list's bounds: the job's events read, and the jobs read for the ones that ran it again. */
const BOM_EVENTS = 2000;
const BOM_JOBS = 1000;
/** How far before a job's first event its parts list reads the machine's baseline. */
const BOM_BASELINE_MS = 86_400_000;

// Read-only: jobs are pulled from sources, never posted (design.md "Phase 3"). The request's user's jobs, each with its phase (issue #548).
export function jobRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/jobs', async (req) => {
    const q = parseWith(jobsQuery, req.query);
    // Off the event loop (issue #2392): through the read pool.
    return { jobs: (await o.tenant(req).store.reads.jobs({ ...(q.status ? { status: q.status } : {}), limit: q.limit })).map(withPhase) };
  });

  // The newest event of each job /api/queue holds (issue #434): each Jobs view card's last event.
  app.get('/api/jobs/last-events', async (req) => {
    const { store, engine } = o.tenant(req);
    const q = engine.getQueue();
    const ids = [...q.waiting, ...q.running, ...q.waitingAnswer, ...q.operatorLed, ...q.parked, ...q.waitingOn, ...q.ended, ...q.locked].map((j) => j.id);
    return { events: store.events.lastOfJobs([...new Set(ids)]) };
  });

  // The job graph (issue #900): the jobs /api/queue holds, the partly done and PR-open jobs whose pull requests wait, the
  // jobs with an open question or hand-off, the newest job of each of their issues, and the jobs these ran again, forked from or carried out — with their issues,
  // pull requests, open questions and hand-offs, and typed edges.
  app.get('/api/jobs/graph', async (req) => {
    const { store, engine } = o.tenant(req);
    const q = engine.getQueue();
    const jobs = new Map<string, Job>();
    for (const j of [...q.waiting, ...q.running, ...q.waitingAnswer, ...q.operatorLed, ...q.parked, ...q.waitingOn, ...q.ended, ...q.locked]) jobs.set(j.id, j);
    for (const j of store.jobs.list({ followed: true, limit: GRAPH_FOLLOWED })) {
      if ((j.sourceState?.source as { follow?: unknown } | undefined)?.follow === 'open') jobs.set(j.id, j);
    }
    const questions = store.questions.list({ status: ['open'], order: 'oldest-first' })
      .map((q) => ({ id: q.id, jobId: q.jobId, text: q.text, since: q.createdAt }));
    const handoffs = store.handoffs.list({ status: 'open' })
      .map((h) => ({ id: h.id, jobId: h.jobId, text: h.tldr?.text ?? h.summary, since: h.openedAt }));
    for (const { jobId } of [...questions, ...handoffs]) {
      const j = jobs.has(jobId) ? undefined : store.jobs.get(jobId);
      if (j) jobs.set(j.id, j);
    }
    // The newest job of each issue here (issue #1036): the issue reads its stage from it, and it supersedes a failure before
    // it, though it ended before the queue's window.
    for (const j of [...jobs.values()]) {
      const newest = j.source?.key ? store.jobs.getBySourceKey(j.source.key) : undefined;
      if (newest && !jobs.has(newest.id)) jobs.set(newest.id, newest);
    }
    // The jobs these come from, a few steps back: the run before, the job forked from, the proposal carried out.
    for (let step = 0, next = [...jobs.values()]; step < GRAPH_STEPS && next.length > 0; step++) {
      const found: Job[] = [];
      for (const j of next) {
        for (const id of [j.rerunOf, j.forkOf?.jobId, j.followOn?.jobId]) {
          if (!id || jobs.has(id)) continue;
          const back = store.jobs.get(id);
          if (back) { jobs.set(id, back); found.push(back); }
        }
      }
      next = found;
    }
    const links = store.events.recent(GRAPH_LINKS, ['job.child_issue_filed']).map((e) => e.data as unknown as JobGraphLink)
      .filter((l) => typeof l.parent?.repo === 'string' && typeof l.parent.number === 'number' && typeof l.child?.repo === 'string' && typeof l.child.number === 'number');
    const maxAttempts = failureSettingsOf(store.settings.getFailureSettings()).maxAttempts;
    // Where each of their items stands (issue #1067): the work-item ledger's, the one answer every view reads.
    const items = new Map<string, WorkItem>();
    for (const j of jobs.values()) {
      const item = j.source?.key && !items.has(j.source.key) ? store.workItems.get(j.source.key) : undefined;
      if (item) items.set(item.key, item);
    }
    // The issues that wait on their batch (issue #1337): what the last sync read from GitHub, and what the ledger holds.
    const awaitingBatch = awaitingBatchKeys(o.tenant(req).registry.statuses());
    const landing = store.settings.getLandingBatches()?.repos ?? {};
    const now = Date.now();
    for (const item of items.values()) if (awaitsBatch(item, (repo) => landing[repo] !== undefined, now)) awaitingBatch.add(item.key);
    // An issue here no job works reads its item too (issue #1895), once each: its jobs may be gone from the graph.
    const more = new Map<string, WorkItem | undefined>();
    const lookup = { get: (key: string) => items.get(key) ?? (more.has(key) ? more.get(key) : more.set(key, store.workItems.get(key)).get(key)) };
    return jobGraph({ jobs: [...jobs.values()], links, issueGraph: { nodes: store.issueGraph.nodes(), edges: store.issueGraph.edges() }, questions, handoffs, maxAttempts, items: lookup, awaitingBatch });
  });

  // A job's parts list (issue #935): its events (an approval of its infra plan among them), questions, hand-off and
  // artifacts, the jobs that ran it again or forked from it, and its job runs (part 2: its cost and usage) — read from a
  // day before its first event, so the machine's baseline has samples with no lane in use.
  app.get('/api/jobs/:id/bom', async (req) => {
    const { id } = parseWith(idParams, req.params);
    const { store } = o.tenant(req);
    const job = store.jobs.get(id);
    if (!job) throw new HttpError(404, `job ${id} not found`);
    const events = store.events.recent(BOM_EVENTS, undefined, id);
    const related = store.jobs.list({ limit: BOM_JOBS }).filter((j) => j.rerunOf === id || j.forkOf?.jobId === id);
    const handoff = store.handoffs.forJob(id);
    const now = new Date();
    const first = Math.min(Date.parse(job.createdAt), ...events.map((e) => Date.parse(e.at)));
    const runs = store.machineHistory.jobRuns({ from: new Date(first - BOM_BASELINE_MS), to: now, jobId: id });
    const preempter = job.preempted ? store.jobs.get(job.preempted.by) : undefined;
    // What its scope uses now (issue #2498): an ended job's scope is reaped, so only a job not ended is looked for.
    const live = TERMINAL_STATUSES.includes(job.status) ? [] : await o.tenant(req).engine.getLiveUse(id);
    return jobBom({
      job, events, questions: store.questions.list({ jobId: id }), artifacts: store.artifacts.list({ jobId: id }),
      related, runs, now: now.toISOString(), ...(handoff ? { handoff } : {}), ...(preempter ? { preempter } : {}), ledger: store.resourceLedger.forJob(id), live,
    });
  });

  // A job's notes (issue #997), oldest first: each with who sent it, how, and where it is — queued, delivered, carried.
  app.get('/api/jobs/:id/notes', async (req) => {
    const { id } = parseWith(idParams, req.params);
    const job = o.tenant(req).store.jobs.get(id);
    if (!job) throw new HttpError(404, `job ${id} not found`);
    return { notes: job.notes ?? [] };
  });

  // A job's trust stamp (issue #655 part 10): the stamp with no MAC, whether it verifies, the intake strictness on the job
  // and what the stamp holds or lets through at the start and at gate 2.
  app.get('/api/jobs/:id/stamp', async (req) => {
    const { id } = parseWith(idParams, req.params);
    const { store } = o.tenant(req);
    const job = byIdOrShortId(store.jobs, id);
    return store.jobs.stampView(job, jobBrake(store.settings.getIntakeStrictness(), job));
  });

  app.get('/api/jobs/:id', async (req) => {
    const { id } = parseWith(idParams, req.params);
    return withPhase(byIdOrShortId(o.tenant(req).store.jobs, id));
  });
}

/** A job by its id, or its short id (issue #1780): the start of its id, as the views show it. 404: none; 409: more than one. */
function byIdOrShortId(jobs: TenantParts['store']['jobs'], id: string): Job {
  const exact = jobs.get(id);
  if (exact) return exact;
  const started = jobIdStarting(jobs.list().map((j) => j.id), id);
  if (started.ambiguous) throw new HttpError(409, `${started.ambiguous} jobs have an id that starts with ${id}: give more of it`);
  const job = started.id ? jobs.get(started.id) : undefined;
  if (!job) throw new HttpError(404, `job ${id} not found`);
  return job;
}
