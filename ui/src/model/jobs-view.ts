// The Jobs view (issues #434, #900): where every job stands, at a glance. It reads the job graph (GET /api/jobs/graph):
// the jobs, their issues and pull requests, typed edges, the job trees and how many jobs are in each stage. The graph mode
// lays each job tree out from its root; the list mode is a row per job. Both filter by stage and by repository. Each job
// row also shows its last event — the newest of what GET /api/jobs/last-events answered and the events the stream
// brought since.
import { hierarchy, tree as d3tree } from 'd3';
import type { DomainEvent, JobGraph, JobGraphEdgeKind, JobGraphNode, JobGraphNodeKind, JobGraphTend, JobStage, JobTree } from './wire.ts';

/** A colour of the status palette (components/status.tsx `Tone`): the model names it, the view paints it. */
export type Tone = 'busy' | 'ok' | 'bad' | 'warn' | 'question' | 'operator' | 'muted';

/** Each stage as the view names and colours it, in the order the counts show. */
export const STAGES: readonly { stage: JobStage; label: string; tone: Tone; title: string }[] = [
  { stage: 'queued', label: 'Queued', tone: 'muted', title: 'waits for a lane' },
  { stage: 'running', label: 'Building it', tone: 'busy', title: 'an agent works it now' },
  { stage: 'waiting', label: 'Waiting', tone: 'question', title: 'waits on a person or the outside world: a question, an operator, parked, its own wait' },
  { stage: 'pr_open', label: 'Ready for review', tone: 'warn', title: 'finished; its pull request is open' },
  { stage: 'partly_done', label: 'Part shipped', tone: 'operator', title: 'shipped part of its issue; the rest runs once its pull request merges' },
  { stage: 'done', label: 'Done', tone: 'ok', title: 'finished, its pull request merged or none' },
  { stage: 'failed', label: 'Failed', tone: 'bad', title: 'failed' },
  { stage: 'cancelled', label: 'Cancelled', tone: 'muted', title: 'cancelled, or turned away at the queue gate' },
  { stage: 'no_job', label: 'Not started', tone: 'muted', title: 'an issue no job works' },
];
const BY_STAGE = new Map(STAGES.map((s) => [s.stage, s]));
export const stageInfo = (stage: JobStage) => BY_STAGE.get(stage)!;

/**
 * Each edge kind as a sentence (issue #935), read from its start to its end: "<start> <words> <end>". Only an issue's
 * blocked-by link says that something must come first.
 */
export const EDGE_TEXT: Record<JobGraphEdgeKind, string> = {
  parent: 'has the sub-issue', follow_up: 'led to the follow-up', works: 'is being worked on by', next_part: 'continues in',
  rerun: 'is being redone as', spawned: 'branched off into', plan_apply: 'planned the work of', opened: 'produced',
  waits_on_merge: 'is waiting on the merge of', closes: 'closes', blocked_by: 'needs this first:', stacked_on: 'goes in after',
  asks: 'is waiting on your answer to', hands_off: 'is waiting on you to take over:',
};

/** Each node kind in plain words. */
export const KIND_TEXT: Record<JobGraphNodeKind, string> = { job: 'job', issue: 'issue', pull_request: 'pull request', question: 'question', handoff: 'hand-off' };

/** The Jobs view's filters: `null` shows every stage or repository. */
export interface JobsFilter { stage: JobStage | null; repo: string | null }
export const NO_FILTER: JobsFilter = { stage: null, repo: null };

const matches = (n: JobGraphNode, f: JobsFilter): boolean =>
  n.kind === 'job' && (f.stage === null || n.stage === f.stage) && (f.repo === null || n.repo === f.repo);

/** The job nodes the filter lets through, the latest stage change first. */
export function jobRows(graph: JobGraph, filter: JobsFilter): JobGraphNode[] {
  return graph.nodes.filter((n) => matches(n, filter)).sort((a, b) => (b.stageSince ?? '').localeCompare(a.stageSince ?? '') || a.id.localeCompare(b.id));
}

/** The trees with a job the filter lets through: the most blocked first, then the newest. */
export function shownTrees(graph: JobGraph, filter: JobsFilter): JobTree[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const newest = (t: JobTree) => t.nodes.reduce((m, id) => { const s = byId.get(id)?.stageSince ?? ''; return s > m ? s : m; }, '');
  return graph.trees.filter((t) => t.nodes.some((id) => matches(byId.get(id)!, filter)))
    .sort((a, b) => Number(b.blocking.length > 0) - Number(a.blocking.length > 0) || newest(b).localeCompare(newest(a)) || a.root.localeCompare(b.root));
}

/** The stages and repositories the jobs have, each once: what the filters offer. */
export function filterChoices(graph: JobGraph): { stages: JobStage[]; repos: string[] } {
  const stages = new Set<JobStage>();
  const repos = new Set<string>();
  for (const n of graph.nodes) {
    if (n.kind !== 'job') continue;
    stages.add(n.stage);
    if (n.repo) repos.add(n.repo);
  }
  return { stages: STAGES.map((s) => s.stage).filter((s) => stages.has(s)), repos: [...repos].sort() };
}

/** How many jobs are in each stage, of the repository chosen (all: `null`): the counts above the view. */
export function stageCounts(graph: JobGraph, repo: string | null): Partial<Record<JobStage, number>> {
  const out: Partial<Record<JobStage, number>> = {};
  for (const n of graph.nodes) if (n.kind === 'job' && (repo === null || n.repo === repo)) out[n.stage] = (out[n.stage] ?? 0) + 1;
  return out;
}

/** The newest event of each job, over every list given; an event with no job is skipped. */
export function lastEvents(...lists: readonly (readonly DomainEvent[])[]): Map<string, DomainEvent> {
  const last = new Map<string, DomainEvent>();
  for (const list of lists) {
    for (const e of list) {
      if (e.jobId === undefined) continue;
      const held = last.get(e.jobId);
      if (!held || e.seq > held.seq) last.set(e.jobId, e);
    }
  }
  return last;
}

/** A node's place in its tree's drawing: its top-left corner. */
export interface Placed { id: string; x: number; y: number }
export interface TreeLayout { placed: Placed[]; width: number; height: number }

export const NODE_W = 210;
export const NODE_H = 54;
const COL = NODE_W + 56;
const ROW = NODE_H + 14;

const KIND_RANK: Record<JobGraphNodeKind, number> = { issue: 0, job: 1, pull_request: 2, question: 3, handoff: 4 };

/**
 * A tree laid out left to right from its root (d3's tidy tree): each node under the first node that reaches it, along
 * an edge either way, so every node of the tree has a place; the edges are drawn over it, every one of them.
 */
export function layoutTree(graph: JobGraph, t: JobTree): TreeLayout {
  const inTree = new Set(t.nodes);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const near = new Map<string, string[]>(t.nodes.map((id) => [id, []]));
  for (const e of graph.edges) {
    if (!inTree.has(e.from) || !inTree.has(e.to)) continue;
    near.get(e.from)!.push(e.to);
    near.get(e.to)!.push(e.from);
  }
  const order = (ids: string[]) => ids.sort((a, b) => KIND_RANK[byId.get(a)!.kind] - KIND_RANK[byId.get(b)!.kind] || a.localeCompare(b));
  const children = new Map<string, string[]>();
  const seen = new Set([t.root]);
  for (let level = [t.root]; level.length > 0;) {
    const next: string[] = [];
    for (const id of level) {
      const kids = order([...new Set(near.get(id)!)].filter((k) => !seen.has(k)));
      for (const k of kids) seen.add(k);
      children.set(id, kids);
      next.push(...kids);
    }
    level = next;
  }
  const root = hierarchy<string>(t.root, (id) => children.get(id) ?? []);
  const laid = d3tree<string>().nodeSize([ROW, COL])(root);
  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = 0;
  laid.each((n) => { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); });
  const placed: Placed[] = [];
  laid.each((n) => { placed.push({ id: n.data, x: n.y, y: n.x - minX }); });
  return { placed, width: maxY + NODE_W, height: maxX - minX + NODE_H };
}

/** A node's progress, as its task count says: `x/y`, or nothing before it has a task list. */
export const tasksText = (n: JobGraphNode): string | undefined => (n.tasks ? `${n.tasks.done}/${n.tasks.total}` : undefined);

/** One tend of a pull request in a few words (issue #927): `rebase by job abcdef01: running`. */
export const tendText = (t: Pick<JobGraphTend, 'jobId' | 'step' | 'status'>): string =>
  `${t.step === 'fix_checks' ? 'fix checks' : 'rebase'} by job ${t.jobId.slice(0, 8)}: ${t.status.replace('_', ' ')}`;

/** A pull request's state and checks in a few words: `open · checks failing`, `merged`, `draft · conflicts`. */
export function pullRequestText(pr: NonNullable<JobGraphNode['pullRequest']>): string {
  const bits = [pr.draft ? 'draft' : pr.state === 'unknown' ? 'not followed yet' : pr.state];
  if (pr.conflicting) bits.push('conflicts');
  if (pr.checks && pr.checks !== 'none' && pr.state === 'open') bits.push(`checks ${pr.checks}`);
  else if (pr.checks === 'none' && pr.state === 'open') bits.push('no checks');
  return bits.join(' · ');
}

/** A pull request's tone: its checks when open, else where it ended. */
export function pullRequestTone(pr: NonNullable<JobGraphNode['pullRequest']>): Tone {
  if (pr.state === 'merged') return 'ok';
  if (pr.state === 'closed' || pr.state === 'abandoned') return 'muted';
  if (pr.conflicting || pr.checks === 'failing') return 'bad';
  return pr.checks === 'passing' ? 'ok' : 'warn';
}
