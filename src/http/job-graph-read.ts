// The job graph's read (issue #900, design.md "The job graph"): what `GET /api/jobs/graph` and planned work (issue #2840)
// make the graph of. Split from jobs.ts so both read the same jobs, and so planned work's numbers are the Jobs view's.
import { failureSettingsOf } from '../domain/failures.ts';
import type { GraphEdge, GraphNode } from '../domain/issue-graph.ts';
import { jobGraph, type JobGraph, type JobGraphLink } from '../domain/job-graph.ts';
import type { Job } from '../domain/types.ts';
import type { WorkItem } from '../domain/work-items.ts';
import { awaitsBatch } from '../domain/work-item-landing.ts';
import { awaitingBatchKeys } from '../sources/intake-live.ts';
import { lineageLinks } from '../engine/plan-sync.ts';
import type { TenantParts } from './tenants.ts';

/** The job graph's bounds: followed jobs read, steps back along a job's origins. */
const GRAPH_FOLLOWED = 500;
const GRAPH_STEPS = 5;

/** The job graph, with the lineage links and the issue graph it was made of. */
export interface JobGraphRead { graph: JobGraph; links: JobGraphLink[]; issueGraph: { nodes: GraphNode[]; edges: GraphEdge[] } }

/**
 * The job graph of the jobs /api/queue holds, the partly done and PR-open jobs whose pull requests wait, the jobs with an
 * open question or hand-off, the newest job of each of their issues — and of each issue `extra.issueKeys` names (planned
 * work's issues, by source key) —, the jobs `extra.jobIds` names (the jobs the plan store links to a work plan), and the
 * jobs these ran again, forked from or carried out — with their issues, pull requests, open questions and hand-offs, and
 * typed edges.
 */
export function readJobGraph(t: TenantParts, extra?: { issueKeys: readonly string[]; jobIds: readonly string[] }): JobGraphRead {
  const { store, engine } = t;
  const links = lineageLinks(store);
  const issueGraph = { nodes: store.issueGraph.nodes(), edges: store.issueGraph.edges() };
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
  for (const id of extra?.jobIds ?? []) {
    const j = jobs.has(id) ? undefined : store.jobs.get(id);
    if (j) jobs.set(j.id, j);
  }
  // The newest job of each issue here (issue #1036): the issue reads its stage from it, and it supersedes a failure before
  // it, though it ended before the queue's window. So does each issue asked for.
  for (const key of new Set([...[...jobs.values()].map((j) => j.source?.key), ...extra?.issueKeys ?? []])) {
    const newest = key ? store.jobs.getBySourceKey(key) : undefined;
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
  const maxAttempts = failureSettingsOf(store.settings.getFailureSettings()).maxAttempts;
  // Where each of their items stands (issue #1067): the work-item ledger's, the one answer every view reads.
  const items = new Map<string, WorkItem>();
  for (const j of jobs.values()) {
    const item = j.source?.key && !items.has(j.source.key) ? store.workItems.get(j.source.key) : undefined;
    if (item) items.set(item.key, item);
  }
  // The issues that wait on their batch (issue #1337): what the last sync read from GitHub, and what the ledger holds.
  const awaitingBatch = awaitingBatchKeys(t.registry.statuses());
  const landing = store.settings.getLandingBatches()?.repos ?? {};
  const now = Date.now();
  for (const item of items.values()) if (awaitsBatch(item, (repo) => landing[repo] !== undefined, now)) awaitingBatch.add(item.key);
  // An issue here no job works reads its item too (issue #1895), once each: its jobs may be gone from the graph.
  const more = new Map<string, WorkItem | undefined>();
  const lookup = { get: (key: string) => items.get(key) ?? (more.has(key) ? more.get(key) : more.set(key, store.workItems.get(key)).get(key)) };
  return { graph: jobGraph({ jobs: [...jobs.values()], links, issueGraph, questions, handoffs, maxAttempts, items: lookup, awaitingBatch }), links, issueGraph };
}
