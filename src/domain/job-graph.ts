// The job graph (issue #900, design.md "The job graph"): where every job stands, and how the jobs, their issues and their
// pull requests hang together. Nodes are jobs, issues and pull requests; edges are typed — a parent issue to its
// sub-issue, an issue to a follow-up a job filed, an issue to the job that works it, a job to the job that runs its issue
// again (the next part after a partly done one), a job to the fork it spawned from a question, a proposal to the job that
// carries out its path, a job to its pull request, and a partly done job to the pull request whose merge lets the rest run;
// an issue to an issue that blocks it, a pull request to the one whose branch it is based on, and a job to its open
// question or hand-off, which are nodes too: each waits on a person. Each node has its **stage**: queued, running, waiting, PR open, partly done, done, failed or cancelled — and an issue no
// job works yet, no job. A pull request the hopper tended lists each tend attempt, oldest first (issue #927). Each group of
// connected nodes is one **job tree**, named by its root, with what blocks the root marked. Pure: no I/O, no clock — the
// route reads the jobs, the lineage links, the issue graph and the open questions and hand-offs, and passes them in.
import { ownWaitOf, type OwnWait } from './own-command.ts';
import type { GraphEdge, GraphNode } from './issue-graph.ts';
import { attemptIn, treeSummary, wordNodes } from './job-words.ts';
import { phaseOf } from './phase.ts';
import type { ChecksState, Tended, TendStep } from './pull-requests.ts';
import type { TaskCount } from './task-count.ts';
import { countStages, treesOf } from './job-trees.ts';
import type { Job, JobStatus } from './types.ts';

/** Where a job stands in its life, in the words the Jobs view uses. */
export const JOB_STAGES = ['queued', 'running', 'waiting', 'pr_open', 'partly_done', 'done', 'failed', 'cancelled', 'no_job'] as const;
export type JobStage = typeof JOB_STAGES[number];

/** A stage that ends nothing more: no node in it blocks its tree's root. */

export type JobGraphNodeKind = 'job' | 'issue' | 'pull_request' | 'question' | 'handoff';

/**
 * `parent`: a parent issue to its sub-issue (GitHub's, or a required child a job filed). `follow_up`: an issue to a
 * follow-up issue a job filed for it. `works`: an issue to a job that works it. `next_part`: a partly done job to the job
 * that runs the rest of its issue; `rerun`: any other job to the job that runs its issue again. `spawned`: a job to a
 * fork made from one of its questions. `plan_apply`: a proposal's job to the job that carries out a path of it.
 * `opened`: a job to its pull request. `waits_on_merge`: a partly done job to its pull request, not merged yet: the rest
 * of its issue runs once it merges. `closes`: a pull request to the issue its merge closes. `blocked_by`: an issue to an
 * issue that blocks it (GitHub's issue dependencies). `stacked_on`: a pull request to the open one whose head branch is
 * its base: it merges after that one. `asks`: a job to its open question. `hands_off`: a job to its open hand-off.
 */
export const JOB_GRAPH_EDGE_KINDS = [
  'parent', 'follow_up', 'works', 'next_part', 'rerun', 'spawned', 'plan_apply', 'opened', 'waits_on_merge', 'closes', 'blocked_by', 'stacked_on', 'asks', 'hands_off',
] as const;
export type JobGraphEdgeKind = typeof JOB_GRAPH_EDGE_KINDS[number];

/** A pull request as the graph shows it: its URL, where it is (open, merged, closed), its checks, draft, conflicts. */
export interface JobGraphPullRequest {
  url: string;
  /** `open`, `merged`, `closed`, `abandoned` (its issue closed as not planned), or `unknown`: not followed yet. */
  state: string;
  checks?: ChecksState | 'none';
  draft?: boolean;
  conflicting?: boolean;
  /** The branch it merges into, and its head branch: a stack, when one's base is another's head. */
  base?: string;
  headRef?: string;
}

export interface JobGraphNode {
  /** `job:<id>`, `issue:<owner/name>#<n>` (lowercase repository), `pr:<url>`, `question:<id>`, `handoff:<id>`. */
  id: string;
  kind: JobGraphNodeKind;
  /**
   * What a person reads on the node first (issue #935): a job's goal, an issue's title (its `owner/name#n` when it has
   * none), a pull request's job's goal, a question's text, a hand-off's summary. The repository and number are apart.
   */
  label: string;
  stage: JobStage;
  /** Where it stands in human terms (issue #935): `Building it (attempt 2 of 3)`, `Ready for review`, `Waiting on you: approve the plan`. */
  stageText: string;
  /** True when it waits on the person: a question, a hand-off, a plan or a report to read. */
  waitsOnYou?: true;
  /** A job's phase when it is not the work itself: `proposal` or `research`. */
  phase?: string;
  /** A job on a wait for its own command (issue #1037): `command` while it runs, `stuck` once flagged stuck. */
  ownWait?: OwnWait;
  /** A job's run in the chain of runs again of its issue (1 the first), and how many the failure settings allow. */
  attempt?: number; attempts?: number;
  /** owner/name, when the node has one. */
  repo?: string;
  /** The issue or pull request number. */
  number?: number;
  url?: string;
  /** A job's node: its id, status, task count, and lane (`<machine>/lane-<n>`: it names the machine too). A question's or a hand-off's: its job's id. */
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
  /** A pull request's node: each tend of it (issue #927), oldest first. Absent: never tended. */
  tends?: JobGraphTend[];
}

/** One tend of a pull request (issue #927): the job the hopper ran to take the step, its status, and when it started and ended. */
export interface JobGraphTend { jobId: string; step: TendStep; status: JobStatus; startedAt?: string; endedAt?: string }

export interface JobGraphEdge { from: string; to: string; kind: JobGraphEdgeKind }

/** A job tree: one group of connected nodes, named by its root, with what blocks the root. */
export interface JobTree {
  root: string;
  nodes: string[];
  /** Nodes not settled that the root waits on, and the nodes on the way to them: the path to highlight. */
  blocking: string[];
  /** How many of its job nodes are in each stage. */
  stages: Partial<Record<JobStage, number>>;
  /** The tree in one line (issue #935): "3 of 4 pieces shipped, 1 being redone, nothing waiting on you." */
  summary: string;
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

/** An open question or hand-off of a job: what the graph shows of it, and since when it waits. */
export interface JobGraphWait { id: string; jobId: string; text: string; since: string }

/**
 * What the graph is made of: the jobs, the lineage links, the issue graph's nodes and edges (issue #437), and the open
 * questions and hand-offs. A question or hand-off of a job not here is left out.
 */
export interface JobGraphInput {
  jobs: readonly Job[];
  links?: readonly JobGraphLink[];
  issueGraph?: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
  questions?: readonly JobGraphWait[];
  handoffs?: readonly JobGraphWait[];
  /** The failure settings' retries per job: a run again's attempt reads "of" one more than it. */
  maxAttempts?: number;
}

interface Followed {
  pullRequest?: string; follow?: string; parts?: unknown; tended?: Tended;
  seen?: { checks?: ChecksState | 'none'; draft?: boolean; conflicting?: boolean; base?: string; headRef?: string };
}

/** A job node's task count is part of the graph's contract: re-exported with it (and so through types.ts). */
export type { TaskCount };
export { treesOf };
/** A job's parts list (issue #935) is the graph's drill-in: its types go out with it (and so through types.ts). */
export type { BomGroup, BomPart, BomStatus, JobBom } from './job-bom.ts';

const followedOf = (job: Job): Followed => (job.sourceState?.source ?? {}) as Followed;

export const issueNodeId = (repo: string, number: number): string => `issue:${repo.toLowerCase()}#${number}`;
export const jobNodeId = (jobId: string): string => `job:${jobId}`;
export const pullRequestNodeId = (url: string): string => `pr:${url}`;
export const questionNodeId = (id: string): string => `question:${id}`;
export const handoffNodeId = (id: string): string => `handoff:${id}`;

/** The longest label a question or hand-off gets: its text's start. */
const WAIT_LABEL = 120;

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
    ...(s.seen?.base ? { base: s.seen.base } : {}), ...(s.seen?.headRef ? { headRef: s.seen.headRef } : {}),
  };
}

/**
 * True while a partly done job's pull request is not merged: the rest of its issue waits on that merge. A job that handed
 * its pull request on to a tend or a rework (follow: tended, reworked) waits on nothing: it is followed no more, and the
 * newer job carries the rest of its issue and its stage (issue #994).
 */
const waitsOnMerge = (job: Job): boolean =>
  job.partlyDone !== undefined && !['merged', 'closed', 'abandoned', 'tended', 'reworked'].includes(followedOf(job).follow ?? '');

/**
 * A job's stage. Queued: waiting for a lane (queued, held, claimed). Running, and on a wait for its own command (issue
 * #1037) until it is flagged stuck. Waiting: on a person or the outside world (a question, an operator, parked, its own
 * wait). Then, once finished: partly done while the part's pull request is not
 * merged; PR open while its own pull request is open; else done. Failed; cancelled (and rejected at the queue gate).
 */
export function stageOf(job: Job): JobStage {
  switch (job.status) {
    case 'queued': case 'held': case 'claimed': return 'queued';
    case 'running': return 'running';
    case 'waiting_on': return ownWaitOf(job) === 'command' ? 'running' : 'waiting';
    case 'waiting_answer': case 'operator_led': case 'parked': return 'waiting';
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
    case 'running': return job.status === 'waiting_on' ? job.wait?.since ?? job.updatedAt : job.startedAt ?? job.updatedAt;
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

/** A followed pull request's states while it is open: followed, not followed yet, or handed to a tend or a rework (issue #927). */
const STILL_OPEN: readonly string[] = ['open', 'unknown', 'tended', 'reworked'];

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
    nodes.set(id, { id, kind: 'issue', label: ref(repo, number), stage: 'no_job', stageText: '', repo, number, url: `https://github.com/${repo}/issues/${number}`, ...before, ...extra });
    return id;
  };
  const prNode = (pr: JobGraphPullRequest, stage: JobStage, label = 'Pull request'): string => {
    const id = pullRequestNodeId(pr.url);
    const m = PR_URL.exec(pr.url);
    nodes.set(id, { id, kind: 'pull_request', label, stage, stageText: '', url: pr.url, pullRequest: pr, ...(m ? { repo: m[1], number: Number(m[2]) } : {}) });
    return id;
  };

  const jobs = [...input.jobs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const byId = new Map(jobs.map((j) => [j.id, j]));
  // Each issue's newest job: the issue reads its stage, its words, and whether a run again redoes a failed run.
  const newestOf = new Map<string, Job>();
  // The issue nodes, from the jobs: each issue takes the stage and parts of its newest job.
  for (const job of jobs) {
    const s = job.source;
    const stage = stageOf(job);
    const pr = pullRequestOf(job);
    const id = jobNodeId(job.id);
    const phase = phaseOf(job), attempt = attemptIn(job, byId), ownWait = ownWaitOf(job);
    nodes.set(id, {
      id, kind: 'job', label: job.spec.goal || s?.title || job.spec.executor, stage, stageText: '', jobId: job.id, status: job.status,
      stageSince: stageSinceOf(job), ...(phase !== 'work' ? { phase } : {}), ...(ownWait ? { ownWait } : {}),
      ...(attempt > 1 ? { attempt, ...(input.maxAttempts !== undefined ? { attempts: input.maxAttempts + 1 } : {}) } : {}),
      ...(s?.repo ? { repo: s.repo } : {}), ...(s?.number !== undefined ? { number: s.number } : {}), ...(s?.url ? { url: s.url } : {}),
      ...(job.tasks ? { tasks: job.tasks } : {}), ...(job.laneId ? { laneId: job.laneId } : {}),
      ...(pr ? { pullRequest: pr } : {}),
      ...(job.partlyDone && stage === 'partly_done' ? {
        partlyDone: { pullRequest: job.partlyDone, afterMerge: s?.repo && s.number !== undefined ? `the next part of ${ref(s.repo, s.number)} runs` : 'the next part of its issue runs' },
      } : {}),
    });
    if (s?.repo && s.number !== undefined) {
      const parts = partsOf(job);
      issueNode(s.repo, s.number, { label: s.title || ref(s.repo, s.number), stage, ...(s.url ? { url: s.url } : {}), ...(parts ? { parts } : {}) });
      newestOf.set(issueNodeId(s.repo, s.number), job);
    }
    if (pr) prNode(pr, pr.state === 'merged' ? 'done' : STILL_OPEN.includes(pr.state) ? (waitsOnMerge(job) ? 'partly_done' : 'pr_open') : 'cancelled', job.spec.goal || s?.title);
  }
  // The tends (issue #927): each job a tend handed its job's pull request to, on that pull request's node.
  for (const job of jobs) {
    const t = followedOf(job).tended;
    const next = t ? byId.get(t.nextJobId) : undefined;
    const pr = t ? nodes.get(pullRequestNodeId(t.pullRequest)) : undefined;
    if (!t || !next || !pr) continue;
    const tend: JobGraphTend = { jobId: next.id, step: t.step, status: next.status,
      ...(next.startedAt ? { startedAt: next.startedAt } : {}), ...(next.finishedAt ? { endedAt: next.finishedAt } : {}) };
    nodes.set(pr.id, { ...pr, tends: [...pr.tends ?? [], tend] });
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
    // An issue that blocks one here.
    if (e.kind === 'blocked_by' && to.kind === 'issue' && nodes.has(graphIssue.get(e.from)!) && !nodes.has(graphIssue.get(e.to)!)) {
      issueNode(String(to.attrs.repo), Number(to.attrs.number), { url: to.id });
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
      ...(typeof n.attrs.title === 'string' ? { label: n.attrs.title } : {}),
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
    else if (e.kind === 'blocked_by') edge(from, 'blocked_by', to);
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
  // A stack: an open pull request whose base is another open one's head branch, in the same repository.
  const heads = new Map<string, string>();
  for (const n of nodes.values()) {
    const pr = n.pullRequest;
    if (n.kind === 'pull_request' && pr?.state === 'open' && pr.headRef && n.repo) heads.set(`${n.repo.toLowerCase()} ${pr.headRef}`, n.id);
  }
  for (const n of nodes.values()) {
    const below = n.kind === 'pull_request' && n.pullRequest?.base && n.repo ? heads.get(`${n.repo.toLowerCase()} ${n.pullRequest.base}`) : undefined;
    if (below) edge(n.id, 'stacked_on', below);
  }
  // The open questions and hand-offs of the jobs here: each waits on a person.
  const waits: ['question' | 'handoff', readonly JobGraphWait[] | undefined, JobGraphEdgeKind][] = [['question', input.questions, 'asks'], ['handoff', input.handoffs, 'hands_off']];
  for (const [kind, list, edgeKind] of waits) {
    for (const w of list ?? []) {
      const job = byId.get(w.jobId);
      if (!job) continue;
      const id = kind === 'question' ? questionNodeId(w.id) : handoffNodeId(w.id);
      const text = w.text.replace(/\s+/g, ' ').trim();
      nodes.set(id, {
        id, kind, label: text.length > WAIT_LABEL ? `${text.slice(0, WAIT_LABEL - 1)}…` : text, stage: 'waiting', stageText: '', jobId: w.jobId, stageSince: w.since,
        ...(job.source?.repo ? { repo: job.source.repo } : {}),
      });
      edge(jobNodeId(w.jobId), edgeKind, id);
    }
  }

  // The words (issue #935): an issue says what its newest job says.
  wordNodes(nodes, newestOf);
  const allNodes = [...nodes.values()];
  const allEdges = [...edges.values()];
  const trees = treesOf(allNodes, allEdges).map((t) => ({ ...t, summary: treeSummary(t, nodes, allEdges, newestOf, byId) }));
  return { nodes: allNodes, edges: allEdges, trees, stages: countStages(allNodes) };
}
