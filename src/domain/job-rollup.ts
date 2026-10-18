// Pull requests roll up on the job graph (issue #1036, design.md "The job graph", part 4). Split from job-graph.ts. Pure,
// and from what the hopper keeps already: no read of its own. A pull request any job or the issue graph saw merged is
// merged for every job that names it — a tend or a rework hands it to a newer job, which follows it to its end —, with no
// checks or conflicts. Where a work item stands, and so whether a failure is still one, is the work-item ledger's alone
// (issue #1067): the graph reads it — `stageInItem` settles a job's stage, `ITEM_STAGE` an issue's —, and nothing here
// derives it. When a job entered its stage (`stageSinceOf`), an issue that waits on its batch (issue #1337, `awaitBatch`),
// and where an issue no job here works stands (issue #1895, `settleIssues`).
import type { GraphNode } from './issue-graph.ts';
import { issueNodeId, pullRequestOf, stageAt, stageOf, type JobGraphNode, type JobGraphPullRequest, type JobStage } from './job-graph.ts';
import type { Job } from './types.ts';
import { isFailureOf, type WorkItem, type WorkItemState } from './work-items.ts';

/** The states a pull request never leaves, and which wins when two say different (issue #1036): merged over the rest. */
const FINAL_RANK: Readonly<Record<string, number>> = { merged: 2, closed: 1, abandoned: 1 };

interface Rolled { final?: string; open?: JobGraphPullRequest }

/**
 * Each pull request the jobs name, rolled up over them and the issue graph (issue #1036): `final`, the state it never
 * leaves (merged, closed, abandoned) when a job's follow or the issue graph saw it there; `open`, what its newest follower
 * saw of it while open. A tend or a rework hands the pull request to a newer job, which follows it to its end.
 */
function rolledPullRequests(jobs: readonly Job[], graphNodes: readonly GraphNode[]): Map<string, Rolled> {
  const out = new Map<string, Rolled>();
  const saw = (url: string, state: string, view?: JobGraphPullRequest) => {
    const r = out.get(url) ?? {};
    const rank = FINAL_RANK[state];
    if (rank !== undefined && (r.final === undefined || rank >= FINAL_RANK[r.final]!)) r.final = state;
    if (state === 'open' && view) r.open = view;
    out.set(url, r);
  };
  for (const job of jobs) {
    const pr = pullRequestOf(job);
    if (pr) saw(pr.url, pr.state, pr);
  }
  // The issue graph says only what one read saw: merged is final; closed or open may have changed since.
  for (const n of graphNodes) if (n.kind === 'pull_request' && String(n.attrs.state ?? '').toLowerCase() === 'merged') saw(n.id, 'merged');
  return out;
}

/** What the graph reads of the rollup. */
export interface Rollup {
  /** A job's pull request as the graph shows it: rolled up over every job that names it. */
  viewOf(job: Job): JobGraphPullRequest | undefined;
  /** Each job's stage by its own run and its pull request, by its id: the work-item ledger settles a failure's (job-graph.ts). */
  stages: Map<string, JobStage>;
}

const followedOf = (job: Job): { follow?: string } => (job.sourceState?.source ?? {}) as { follow?: string };

/** The rollup of `jobs`, oldest first, over the issue graph's nodes. */
export function rollUp(jobs: readonly Job[], graphNodes: readonly GraphNode[]): Rollup {
  const rolled = rolledPullRequests(jobs, graphNodes);
  const viewOf = (job: Job): JobGraphPullRequest | undefined => {
    const pr = pullRequestOf(job);
    const r = pr && rolled.get(pr.url);
    if (!pr || !r) return pr;
    // A pull request that ended shows no checks, draft or conflicts: they are what it was, not what it is.
    if (r.final) return { url: pr.url, state: r.final };
    return r.open ? { ...r.open, state: pr.state } : pr;
  };
  const stages = new Map<string, JobStage>();
  for (const job of jobs) stages.set(job.id, stageAt(job, rolled.get(pullRequestOf(job)?.url ?? '')?.final ?? followedOf(job).follow));
  return { viewOf, stages };
}

/** An issue's stage: its work item's state, in the graph's words (issue #1067). */
export const ITEM_STAGE: Readonly<Record<WorkItemState, JobStage>> = {
  waiting_for_approval: 'waiting', queued: 'queued', working: 'running', needs_you: 'waiting', waiting_outside: 'waiting',
  pr_open: 'pr_open', partly_done: 'partly_done', done: 'done', failed: 'failed', blocked: 'waiting', dropped: 'cancelled',
};

/**
 * A job's stage, settled by its work item (issue #1067). A failed or cancelled job is `failed` only while the ledger has
 * its item failed on it, and `waiting` while its item is handed to a person on it; the item's own job, dropped, stays
 * cancelled (a person's dismissal: superseded); else something took its place: superseded. A part's job is done once its
 * item is. With no item (a job of no source), its own stage.
 */
export function stageInItem(job: Job, stage: JobStage, item: WorkItem | undefined): JobStage {
  if (!item) return stage;
  if (stage === 'partly_done') return item.state === 'done' ? 'done' : stage;
  if (stage !== 'failed' && stage !== 'cancelled') return stage;
  if (isFailureOf(item, job.id)) return item.state === 'failed' ? 'failed' : 'waiting';
  if (item.jobId === job.id && item.state === 'dropped' && job.dismissedAt === undefined) return 'cancelled';
  return 'superseded';
}

/** When a job entered its stage, as near as its record tells: the moment its fields say, else its last change. */
export function stageSinceOf(job: Job): string {
  switch (stageOf(job)) {
    case 'queued': return job.createdAt;
    case 'running': return job.status === 'waiting_on' ? job.wait?.since ?? job.updatedAt : job.startedAt ?? job.updatedAt;
    case 'waiting': return job.wait?.since ?? job.parked?.at ?? job.updatedAt;
    default: return job.finishedAt ?? job.updatedAt;
  }
}

const ISSUE_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/;

/**
 * The issues that wait on their batch (issue #1337), by URL, are done whatever their job's end or their item: their work
 * merged into the landing branch, and their batch run's merge closes them. Only the issue nodes already in `nodes`.
 */
export function awaitBatch(nodes: Map<string, JobGraphNode>, urls: Iterable<string>): void {
  for (const url of urls) {
    const m = ISSUE_URL.exec(url);
    const id = m ? issueNodeId(m[1]!, Number(m[2])) : undefined;
    const before = id ? nodes.get(id) : undefined;
    if (id && before) nodes.set(id, { ...before, stage: 'done', awaitsBatch: true });
  }
}

/**
 * An issue no job here works (issue #1895): its own state first — closed as completed is done, closed as not planned or as
 * a duplicate is closed —, then its work item's (its jobs may be gone from the graph), and only an open issue with neither
 * is not started. The ledger's word on the issue comes before the issue graph's read (`reads`, by node id), which may be
 * older than its close.
 */
export function settleIssues(nodes: Map<string, JobGraphNode>, reads: ReadonlyMap<string, GraphNode['attrs']>, items: Pick<ReadonlyMap<string, WorkItem>, 'get'> | undefined): void {
  for (const n of nodes.values()) {
    if (n.kind !== 'issue' || n.stage !== 'no_job') continue;
    const item = n.url ? items?.get(n.url) : undefined;
    const read = reads.get(n.id);
    const state = String((item?.issueState ? item.issueState : read?.state) ?? '').toLowerCase();
    const reason = String((item?.issueState ? item.issueReason : read?.stateReason) ?? '').toLowerCase();
    if (state === 'closed') nodes.set(n.id, { ...n, ...(reason === 'not_planned' || reason === 'duplicate' ? { stage: 'cancelled', closed: true } : { stage: 'done' }) });
    else if (item) nodes.set(n.id, { ...n, stage: ITEM_STAGE[item.state] });
  }
}
