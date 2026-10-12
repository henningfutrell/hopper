// The job graph (issue #900, design.md "The job graph"): where every job stands, and how the jobs, their issues and their
// pull requests hang together. Nodes are jobs, issues and pull requests; edges are typed — a parent issue to its
// sub-issue, an issue to a follow-up a job filed, an issue to the job that works it, a job to the job that runs its issue
// again (the next part after a partly done one), a job to the fork it spawned from a question, a proposal to the job that
// carries out its path, a job to its pull request, and a partly done job to the pull request whose merge lets the rest run.
// Each node has its **stage**: queued, running, waiting, PR open, partly done, done, failed or cancelled — and an issue no
// job works yet, no job. Each group of
// connected nodes is one **job tree**, named by its root, with what blocks the root marked. Pure: no I/O, no clock — the
// route reads the jobs, the lineage links and the issue graph, and passes them in.
import type { GraphEdge, GraphNode } from './issue-graph.ts';
import type { ChecksState } from './pull-requests.ts';
import type { TaskCount } from './task-count.ts';
import type { Job, JobStatus } from './types.ts';

/** Where a job stands in its life, in the words the Jobs view uses. */
export const JOB_STAGES = ['queued', 'running', 'waiting', 'pr_open', 'partly_done', 'done', 'failed', 'cancelled', 'no_job'] as const;
export type JobStage = typeof JOB_STAGES[number];

/** A stage that ends nothing more: no node in it blocks its tree's root. */
const SETTLED: readonly JobStage[] = ['done', 'cancelled'];

export type JobGraphNodeKind = 'job' | 'issue' | 'pull_request';

/**
 * `parent`: a parent issue to its sub-issue (GitHub's, or a required child a job filed). `follow_up`: an issue to a
 * follow-up issue a job filed for it. `works`: an issue to a job that works it. `next_part`: a partly done job to the job
 * that runs the rest of its issue; `rerun`: any other job to the job that runs its issue again. `spawned`: a job to a
 * fork made from one of its questions. `plan_apply`: a proposal's job to the job that carries out a path of it.
 * `opened`: a job to its pull request. `waits_on_merge`: a partly done job to its pull request, not merged yet: the rest
 * of its issue runs once it merges. `closes`: a pull request to the issue its merge closes.
 */
export const JOB_GRAPH_EDGE_KINDS = ['parent', 'follow_up', 'works', 'next_part', 'rerun', 'spawned', 'plan_apply', 'opened', 'waits_on_merge', 'closes'] as const;
export type JobGraphEdgeKind = typeof JOB_GRAPH_EDGE_KINDS[number];

/** A pull request as the graph shows it: its URL, where it is (open, merged, closed), its checks, draft, conflicts. */
export interface JobGraphPullRequest {
  url: string;
  /** `open`, `merged`, `closed`, `abandoned` (its issue closed as not planned), or `unknown`: not followed yet. */
  state: string;
  checks?: ChecksState | 'none';
  draft?: boolean;
  conflicting?: boolean;
}

export interface JobGraphNode {
  /** `job:<id>`, `issue:<owner/name>#<n>` (lowercase repository), `pr:<url>`. */
  id: string;
  kind: JobGraphNodeKind;
  /** What a person reads on the node: a job's goal, an issue's title, a pull request's `#n`. */
  label: string;
  stage: JobStage;
  /** owner/name, when the node has one. */
  repo?: string;
  /** The issue or pull request number. */
  number?: number;
  url?: string;
  /** A job's node: its id, status, task count, and lane (`<machine>/lane-<n>`: it names the machine too). */
  jobId?: string;
  status?: JobStatus;
  tasks?: TaskCount;
  laneId?: string;
  /** When the node entered its stage, as near as its record tells (ISO): what "time in stage" counts from. */
  stageSince?: string;
  /** A job's pull request, or a pull request node's own state. */
  pullRequest?: JobGraphPullRequest;
  /** A partly done job: the pull request that blocks the rest, and what runs once it merges. */
  partlyDone?: { pullRequest: string; afterMerge: string };
  /** An issue's parts, as its newest job last saw them (issue #729). */
  parts?: { done: number; total: number };
}

export interface JobGraphEdge { from: string; to: string; kind: JobGraphEdgeKind }

/** A job tree: one group of connected nodes, named by its root, with what blocks the root. */
export interface JobTree {
  root: string;
  nodes: string[];
  /** Nodes not settled that the root waits on, and the nodes on the way to them: the path to highlight. */
  blocking: string[];
  /** How many of its job nodes are in each stage. */
  stages: Partial<Record<JobStage, number>>;
}

/** The job graph: every node and typed edge, the trees, and how many jobs are in each stage. */
export interface JobGraph {
  nodes: JobGraphNode[];
  edges: JobGraphEdge[];
  trees: JobTree[];
  stages: Partial<Record<JobStage, number>>;
}

/** One link a job recorded as it filed a child issue (`job.child_issue_filed`, issue #729). */
export interface JobGraphLink { parent: { repo: string; number: number }; child: { repo: string; number: number; url?: string }; required: boolean }

/** What the graph is made of: the jobs, the lineage links, and the issue graph's nodes and edges (issue #437). */
export interface JobGraphInput {
  jobs: readonly Job[];
  links?: readonly JobGraphLink[];
  issueGraph?: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
}

interface Followed { pullRequest?: string; follow?: string; seen?: { checks?: ChecksState | 'none'; draft?: boolean; conflicting?: boolean }; parts?: unknown }

/** A job node's task count is part of the graph's contract: re-exported with it (and so through types.ts). */
export type { TaskCount };

const followedOf = (job: Job): Followed => (job.sourceState?.source ?? {}) as Followed;

export const issueNodeId = (repo: string, number: number): string => `issue:${repo.toLowerCase()}#${number}`;
export const jobNodeId = (jobId: string): string => `job:${jobId}`;
export const pullRequestNodeId = (url: string): string => `pr:${url}`;

const PR_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;

/** A job's pull request, as its source last followed it; undefined when it has none. */
export function pullRequestOf(job: Job): JobGraphPullRequest | undefined {
  const s = followedOf(job);
  const url = typeof s.pullRequest === 'string' ? s.pullRequest : job.partlyDone;
  if (!url) return undefined;
  return {
    url, state: typeof s.follow === 'string' ? s.follow : 'unknown',
    ...(s.seen?.checks ? { checks: s.seen.checks } : {}),
    ...(s.seen?.draft !== undefined ? { draft: s.seen.draft } : {}),
    ...(s.seen?.conflicting !== undefined ? { conflicting: s.seen.conflicting } : {}),
  };
}

/** True while a partly done job's pull request is not merged: the rest of its issue waits on that merge. */
const waitsOnMerge = (job: Job): boolean => job.partlyDone !== undefined && !['merged', 'closed', 'abandoned'].includes(followedOf(job).follow ?? '');

/**
 * A job's stage. Queued: waiting for a lane (queued, held, claimed). Running. Waiting: on a person or the outside world
 * (a question, an operator, parked, its own wait). Then, once finished: partly done while the part's pull request is not
 * merged; PR open while its own pull request is open; else done. Failed; cancelled (and rejected at the queue gate).
 */
export function stageOf(job: Job): JobStage {
  switch (job.status) {
    case 'queued': case 'held': case 'claimed': return 'queued';
    case 'running': return 'running';
    case 'waiting_answer': case 'operator_led': case 'parked': case 'waiting_on': return 'waiting';
    case 'failed': return 'failed';
    case 'cancelled': case 'rejected': return 'cancelled';
    case 'finished':
      if (waitsOnMerge(job)) return 'partly_done';
      return followedOf(job).follow === 'open' ? 'pr_open' : 'done';
  }
}

/** When a job entered its stage, as near as its record tells: the moment its fields say, else its last change. */
export function stageSinceOf(job: Job): string {
  switch (stageOf(job)) {
    case 'queued': return job.createdAt;
    case 'running': return job.startedAt ?? job.updatedAt;
    case 'waiting': return job.wait?.since ?? job.parked?.at ?? job.updatedAt;
    default: return job.finishedAt ?? job.updatedAt;
  }
}

const partsOf = (job: Job): { done: number; total: number } | undefined => {
  const p = followedOf(job).parts as { done?: unknown; total?: unknown } | undefined;
  if (p && typeof p.done === 'number' && typeof p.total === 'number') return { done: p.done, total: p.total };
  return job.source?.parts;
};

const ref = (repo: string, number: number): string => `${repo}#${number}`;

/** The job graph of `input`. Deterministic: the same input gives the same nodes, edges and trees, in the same order. */
export function jobGraph(input: JobGraphInput): JobGraph {
  const nodes = new Map<string, JobGraphNode>();
  const edges = new Map<string, JobGraphEdge>();
  const edge = (from: string, kind: JobGraphEdgeKind, to: string) => {
    if (from !== to && nodes.has(from) && nodes.has(to)) edges.set(`${from} ${kind} ${to}`, { from, to, kind });
  };
  const issueNode = (repo: string, number: number, extra: Partial<JobGraphNode> = {}): string => {
    const id = issueNodeId(repo, number);
    const before = nodes.get(id);
    nodes.set(id, { id, kind: 'issue', label: ref(repo, number), stage: 'no_job', repo, number, url: `https://github.com/${repo}/issues/${number}`, ...before, ...extra });
    return id;
  };
  const prNode = (pr: JobGraphPullRequest, stage: JobStage): string => {
    const id = pullRequestNodeId(pr.url);
    const m = PR_URL.exec(pr.url);
    nodes.set(id, { id, kind: 'pull_request', label: m ? `PR #${m[2]}` : 'PR', stage, url: pr.url, pullRequest: pr, ...(m ? { repo: m[1], number: Number(m[2]) } : {}) });
    return id;
  };

  const jobs = [...input.jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const byId = new Map(jobs.map((j) => [j.id, j]));
  // The issue nodes, from the jobs: each issue takes the stage and parts of its newest job.
  for (const job of jobs) {
    const s = job.source;
    const stage = stageOf(job);
    const pr = pullRequestOf(job);
    const id = jobNodeId(job.id);
    nodes.set(id, {
      id, kind: 'job', label: job.spec.goal || s?.title || job.spec.executor, stage, jobId: job.id, status: job.status,
      stageSince: stageSinceOf(job),
      ...(s?.repo ? { repo: s.repo } : {}), ...(s?.number !== undefined ? { number: s.number } : {}), ...(s?.url ? { url: s.url } : {}),
      ...(job.tasks ? { tasks: job.tasks } : {}), ...(job.laneId ? { laneId: job.laneId } : {}),
      ...(pr ? { pullRequest: pr } : {}),
      ...(job.partlyDone && stage === 'partly_done' ? {
        partlyDone: { pullRequest: job.partlyDone, afterMerge: s?.repo && s.number !== undefined ? `the next part of ${ref(s.repo, s.number)} runs` : 'the next part of its issue runs' },
      } : {}),
    });
    if (s?.repo && s.number !== undefined) {
      const parts = partsOf(job);
      issueNode(s.repo, s.number, { label: s.title ? `${ref(s.repo, s.number)} ${s.title}` : ref(s.repo, s.number), stage, ...(s.url ? { url: s.url } : {}), ...(parts ? { parts } : {}) });
    }
    if (pr) prNode(pr, pr.state === 'merged' ? 'done' : pr.state === 'open' || pr.state === 'unknown' ? (waitsOnMerge(job) ? 'partly_done' : 'pr_open') : 'cancelled');
  }

  // The lineage links (issue #729) add the issues they name; the issue graph (issue #437) adds sub-issues and closers of
  // the issues already here, and nothing beyond them.
  for (const l of input.links ?? []) {
    issueNode(l.parent.repo, l.parent.number);
    issueNode(l.child.repo, l.child.number, l.child.url ? { url: l.child.url } : {});
  }
  const graphIssue = new Map<string, string>();
  for (const n of input.issueGraph?.nodes ?? []) {
    if ((n.kind === 'issue' || n.kind === 'pull_request') && typeof n.attrs.repo === 'string' && typeof n.attrs.number === 'number') {
      graphIssue.set(n.id, n.kind === 'issue' ? issueNodeId(n.attrs.repo, n.attrs.number) : pullRequestNodeId(n.id));
    }
  }
  const graphNode = new Map((input.issueGraph?.nodes ?? []).map((n) => [n.id, n]));
  for (const e of input.issueGraph?.edges ?? []) {
    const from = graphNode.get(e.from);
    const to = graphNode.get(e.to);
    if (!from || !to || !graphIssue.has(e.from) || !graphIssue.has(e.to)) continue;
    // A sub-issue of an issue here; a pull request that closes one.
    if (e.kind === 'sub_issue_of' && nodes.has(graphIssue.get(e.to)!) && !nodes.has(graphIssue.get(e.from)!)) {
      issueNode(String(from.attrs.repo), Number(from.attrs.number), { url: from.id });
    }
    if (e.kind === 'closes' && nodes.has(graphIssue.get(e.to)!) && !nodes.has(graphIssue.get(e.from)!)) {
      const state = String(from.attrs.state ?? 'unknown').toLowerCase();
      prNode({ url: from.id, state }, state === 'merged' ? 'done' : state === 'open' ? 'pr_open' : 'cancelled');
    }
  }
  for (const n of input.issueGraph?.nodes ?? []) {
    const id = graphIssue.get(n.id);
    if (n.kind !== 'issue' || !id || !nodes.has(id)) continue;
    const before = nodes.get(id)!;
    const closed = n.attrs.state === 'CLOSED' || n.attrs.state === 'closed';
    nodes.set(id, {
      ...before,
      ...(typeof n.attrs.title === 'string' ? { label: `${ref(before.repo!, before.number!)} ${n.attrs.title}` } : {}),
      // An issue no job here works shows where GitHub has it: closed is done; open still has no job.
      ...(before.stage === 'no_job' && closed ? { stage: 'done' } : {}),
    });
  }

  // The edges.
  for (const l of input.links ?? []) edge(issueNodeId(l.parent.repo, l.parent.number), l.required ? 'parent' : 'follow_up', issueNodeId(l.child.repo, l.child.number));
  for (const e of input.issueGraph?.edges ?? []) {
    const from = graphIssue.get(e.from);
    const to = graphIssue.get(e.to);
    if (!from || !to) continue;
    if (e.kind === 'sub_issue_of') edge(to, 'parent', from);
    else if (e.kind === 'closes') edge(from, 'closes', to);
  }
  for (const job of jobs) {
    const id = jobNodeId(job.id);
    const s = job.source;
    if (s?.repo && s.number !== undefined) edge(issueNodeId(s.repo, s.number), 'works', id);
    if (job.rerunOf && byId.has(job.rerunOf)) edge(jobNodeId(job.rerunOf), byId.get(job.rerunOf)!.partlyDone ? 'next_part' : 'rerun', id);
    if (job.forkOf && byId.has(job.forkOf.jobId)) edge(jobNodeId(job.forkOf.jobId), 'spawned', id);
    if (job.followOn && byId.has(job.followOn.jobId)) edge(jobNodeId(job.followOn.jobId), 'plan_apply', id);
    const pr = pullRequestOf(job);
    if (pr) edge(id, waitsOnMerge(job) ? 'waits_on_merge' : 'opened', pullRequestNodeId(pr.url));
  }

  const allNodes = [...nodes.values()];
  const allEdges = [...edges.values()];
  const trees = treesOf(allNodes, allEdges);
  return { nodes: allNodes, edges: allEdges, trees, stages: countStages(allNodes) };
}

const countStages = (nodes: readonly JobGraphNode[]): Partial<Record<JobStage, number>> => {
  const out: Partial<Record<JobStage, number>> = {};
  for (const n of nodes) if (n.kind === 'job') out[n.stage] = (out[n.stage] ?? 0) + 1;
  return out;
};

/** Root order: an issue before a job before a pull request, then by id. */
const KIND_RANK: Record<JobGraphNodeKind, number> = { issue: 0, job: 1, pull_request: 2 };

/**
 * The job trees: each group of connected nodes, rooted at a node no edge leads into (an issue first), else at its first
 * node. `blocking`: the root's unsettled descendants and every node on a way from the root to one.
 */
export function treesOf(nodes: readonly JobGraphNode[], edges: readonly JobGraphEdge[]): JobTree[] {
  const out = new Map<string, string[]>();
  const into = new Map<string, number>();
  const near = new Map<string, string[]>();
  for (const n of nodes) { out.set(n.id, []); near.set(n.id, []); into.set(n.id, 0); }
  for (const e of edges) {
    out.get(e.from)!.push(e.to);
    near.get(e.from)!.push(e.to);
    near.get(e.to)!.push(e.from);
    into.set(e.to, into.get(e.to)! + 1);
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const order = [...nodes].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.id.localeCompare(b.id));
  const placed = new Set<string>();
  const trees: JobTree[] = [];
  for (const start of order) {
    if (placed.has(start.id)) continue;
    const group: string[] = [];
    for (const stack = [start.id]; stack.length > 0;) {
      const id = stack.pop()!;
      if (placed.has(id)) continue;
      placed.add(id);
      group.push(id);
      stack.push(...near.get(id)!);
    }
    const members = order.filter((n) => group.includes(n.id));
    const root = (members.find((n) => into.get(n.id) === 0) ?? members[0]!).id;
    // A node blocks the root when it is unsettled, or leads to one that does; a cycle counts once.
    const blocks = new Map<string, boolean>();
    const visit = (id: string): boolean => {
      const known = blocks.get(id);
      if (known !== undefined) return known;
      blocks.set(id, false);
      let b = !SETTLED.includes(byId.get(id)!.stage) && id !== root;
      for (const to of out.get(id)!) if (visit(to)) b = true;
      blocks.set(id, b);
      return b;
    };
    visit(root);
    const blocking = members.filter((n) => blocks.get(n.id) === true && n.id !== root).map((n) => n.id);
    trees.push({ root, nodes: members.map((n) => n.id), blocking, stages: countStages(members) });
  }
  return trees;
}
