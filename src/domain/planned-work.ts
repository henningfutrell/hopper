// Planned work (issue #2840, design.md "Planned work"): a **work plan** — an issue — broken down into **plan pieces** (its
// sub-issues) and **plan tasks** (theirs), each tied to the jobs of its issue, with where each stands rolled up from those
// jobs. The tree is GitHub's sub-issues as the issue graph keeps them, and the required children jobs filed; the jobs and
// their stages are the job graph's. Nothing is copied or kept: made on each read. Pure: the route reads the issue graph,
// the lineage links and the job graph, and passes them in.
import type { GraphEdge, GraphNode } from './issue-graph.ts';
import { issueNodeId, type JobGraph, type JobGraphLink, type JobGraphNode, type JobStage } from './job-graph.ts';
import type { JobStatus } from './types.ts';

/** Where a plan task, a plan piece or a work plan stands. */
export const PLAN_STATUSES = ['planned', 'running', 'done', 'blocked'] as const;
export type PlanStatus = typeof PLAN_STATUSES[number];

/** A job of a plan task's issue, as the job graph has it: read, never copied. */
export interface PlanJob { id: string; status: JobStatus; stage: JobStage; stageText: string; pullRequest?: string }

/** One issue of the tree: `owner/name#n` (lowercase repository), its title, its URL and where it stands. */
interface PlanIssue { id: string; repo: string; number: number; title: string; url: string; status: PlanStatus }

/**
 * A plan task: an issue under a plan piece, its jobs (and its own sub-issues' jobs), the issues that block it, and when it
 * changed last: the newest of its issues' updates and its jobs' stage changes.
 */
export interface PlanTask extends PlanIssue { dependsOn: string[]; jobs: PlanJob[]; updatedAt?: string }

/** A plan piece: a sub-issue of the work plan, its plan tasks, the jobs of its own issue, and its **piece artifact**. */
export interface PlanPiece extends PlanIssue { tasks: PlanTask[]; jobs: PlanJob[]; artifact?: string }

/** A work plan: its plan pieces, the jobs of its own issue, and how many of its plan tasks are in each status. */
export interface WorkPlan extends PlanIssue { pieces: PlanPiece[]; jobs: PlanJob[]; counts: Record<PlanStatus, number> }

export interface PlannedWorkInput {
  root: { repo: string; number: number };
  issueGraph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
  links: readonly JobGraphLink[];
  graph: JobGraph;
}

/**
 * Where something stands from where its parts stand: nothing, or only planned parts, is planned; a blocked part blocks
 * it; else a part that runs, or done parts beside planned ones, runs it; all parts done is done.
 */
export function rollUpStatuses(statuses: readonly PlanStatus[]): PlanStatus {
  if (statuses.includes('blocked')) return 'blocked';
  if (statuses.every((s) => s === 'planned')) return 'planned';
  if (statuses.every((s) => s === 'done')) return 'done';
  return 'running';
}

/**
 * A job's part in the roll-up, or undefined when it counts for nothing: a failure or a cancel that something took the place
 * of (`superseded`), or a cancel. Failed, or waiting on a person, blocks; done is done; any other stage is work in motion.
 */
function jobStatus(n: JobGraphNode): PlanStatus | undefined {
  if (n.stage === 'superseded' || n.stage === 'cancelled') return undefined;
  if (n.stage === 'failed' || n.waitsOnYou || (n.stage === 'waiting' && n.status === 'operator_led')) return 'blocked';
  return n.stage === 'done' ? 'done' : 'running';
}

/** The longest piece artifact kept: a line of an issue body, not a page. */
const ARTIFACT_MAX = 300;

/**
 * A plan piece's **piece artifact** from its issue's body: the text of its first `Artifact:` line (any case, in bold or as
 * a list item too), at most 300 characters; empty when it has none. What a person judges the piece by: a screenshot, a
 * pull request, a report, or a link to one.
 */
export function pieceArtifactOf(body: string): string {
  const m = /^[ \t]*(?:[-*][ \t]+)?\**artifact\**[ \t]*:[ \t]*\**[ \t]*(.*)$/im.exec(body);
  return (m?.[1] ?? '').trim().slice(0, ARTIFACT_MAX);
}

/** An issue's URL from its ref. */
const issueUrl = (ref: string): string => { const [repo, n] = ref.split('#'); return `https://github.com/${repo}/issues/${n}`; };

/** The plan ref of an issue: `owner/name#n`, the repository lowercase, as the job graph's issue nodes name it. */
const refOf = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`;

/** What the issue graph and the lineage links say of the issues: each one known, its sub-issues, and what blocks it. */
interface Tree {
  known: Map<string, { repo: string; number: number; url: string; title?: string; artifact?: string; updatedAt?: string }>;
  children: Map<string, Set<string>>;
  blockers: Map<string, Set<string>>;
}

function treeOf(issueGraph: PlannedWorkInput['issueGraph'], links: readonly JobGraphLink[]): Tree {
  // The issues the issue graph knows, by ref: their repository, number, title and URL.
  const known: Tree['known'] = new Map();
  const byUrl = new Map<string, string>();
  for (const n of issueGraph.nodes) {
    if (n.kind !== 'issue' || typeof n.attrs.repo !== 'string' || typeof n.attrs.number !== 'number') continue;
    const ref = refOf(n.attrs.repo, n.attrs.number);
    const text = (k: string) => (typeof n.attrs[k] === 'string' && n.attrs[k] !== '' ? { [k]: n.attrs[k] } : {});
    known.set(ref, { repo: n.attrs.repo, number: n.attrs.number, url: n.id, ...text('title'), ...text('artifact'), ...text('updatedAt') });
    byUrl.set(n.id, ref);
  }
  // Each issue's sub-issues: GitHub's, and the required children jobs filed.
  const children: Tree['children'] = new Map(), blockers: Tree['blockers'] = new Map();
  const add = (m: Map<string, Set<string>>, from: string, to: string) => { if (from !== to) m.set(from, (m.get(from) ?? new Set()).add(to)); };
  for (const e of issueGraph.edges) {
    const from = byUrl.get(e.from), to = byUrl.get(e.to);
    if (!from || !to) continue;
    if (e.kind === 'sub_issue_of') add(children, to, from);
    else if (e.kind === 'blocked_by') add(blockers, from, to);
  }
  for (const l of links) {
    if (!l.required) continue;
    const child = refOf(l.child.repo, l.child.number);
    if (!known.has(child)) known.set(child, { repo: l.child.repo, number: l.child.number, url: l.child.url ?? `https://github.com/${l.child.repo}/issues/${l.child.number}` });
    add(children, refOf(l.parent.repo, l.parent.number), child);
  }
  return { known, children, blockers };
}

/**
 * The URL of every issue of the work plan whose root issue is `root`, the root first: what the route reads the jobs of.
 * Undefined when the issue graph and the lineage links know no such issue.
 */
export function planIssueUrls(root: PlannedWorkInput['root'], issueGraph: PlannedWorkInput['issueGraph'], links: readonly JobGraphLink[]): string[] | undefined {
  const { known, children } = treeOf(issueGraph, links);
  const start = refOf(root.repo, root.number);
  if (!known.has(start) && !children.has(start)) return undefined;
  const all = [start];
  for (let i = 0; i < all.length; i++) for (const k of children.get(all[i]!) ?? []) if (!all.includes(k)) all.push(k);
  return all.map((r) => known.get(r)?.url ?? issueUrl(r === start ? `${root.repo}#${root.number}` : r));
}

/** The work plan whose root issue is `input.root`. Deterministic: sub-issues in the order of their repository and number. */
export function plannedWork(input: PlannedWorkInput): WorkPlan {
  const { known, children, blockers } = treeOf(input.issueGraph, input.links);
  // The job graph's issues and their jobs.
  const nodes = new Map(input.graph.nodes.map((n) => [n.id, n]));
  const jobsOf = new Map<string, PlanJob[]>();
  const since = new Map<string, string[]>();
  const counted = new Map<string, PlanStatus[]>();
  for (const e of input.graph.edges) {
    const job = e.kind === 'works' ? nodes.get(e.to) : undefined;
    if (!job?.jobId || !job.status) continue;
    jobsOf.set(e.from, [...jobsOf.get(e.from) ?? [], {
      id: job.jobId, status: job.status, stage: job.stage, stageText: job.stageText, ...(job.pullRequest ? { pullRequest: job.pullRequest.url } : {}),
    }]);
    if (job.stageSince) since.set(e.from, [...since.get(e.from) ?? [], job.stageSince]);
    const s = jobStatus(job);
    if (s) counted.set(e.from, [...counted.get(e.from) ?? [], s]);
  }
  const graphId = (ref: string): string => { const k = known.get(ref); return k ? issueNodeId(k.repo, k.number) : `issue:${ref}`; };

  const root = refOf(input.root.repo, input.root.number);
  const kids = (ref: string): string[] => [...children.get(ref) ?? []].sort((a, b) => order(a, b));
  const order = (a: string, b: string): number => {
    const x = known.get(a), y = known.get(b);
    return (x?.repo.toLowerCase() ?? a).localeCompare(y?.repo.toLowerCase() ?? b) || (x?.number ?? 0) - (y?.number ?? 0);
  };
  const issue = (ref: string, status: PlanStatus): PlanIssue => {
    const k = known.get(ref);
    const [repo = '', n = '0'] = ref.split('#');
    return { id: ref, repo: k?.repo ?? repo, number: k?.number ?? Number(n), title: k?.title ?? nodes.get(graphId(ref))?.label ?? ref, url: k?.url ?? issueUrl(ref), status };
  };
  // Where an issue's own jobs put it; undefined: no job of it counts.
  const ownStatus = (ref: string): PlanStatus | undefined => { const s = counted.get(graphId(ref)); return s?.length ? rollUpStatuses(s) : undefined; };
  // An issue with no job that counts is done when it is: closed as completed, or its item done; else planned.
  const graphNodes = new Map(input.issueGraph.nodes.map((n) => [n.id, n]));
  const settled = (ref: string): boolean => nodes.get(graphId(ref))?.stage === 'done' || closedCompleted(graphNodes.get(known.get(ref)?.url ?? ''));

  const seen = new Set<string>([root]);
  // A plan task: its issue and every sub-issue under it, once each.
  const task = (ref: string): PlanTask => {
    const under = [ref];
    for (let i = 0; i < under.length; i++) for (const k of kids(under[i]!)) if (!seen.has(k)) { seen.add(k); under.push(k); }
    const statuses = under.flatMap((r) => counted.get(graphId(r)) ?? []);
    const status = statuses.length ? rollUpStatuses(statuses) : under.every(settled) ? 'done' : 'planned';
    const updatedAt = newest(under.flatMap((r) => [known.get(r)?.updatedAt, ...since.get(graphId(r)) ?? []]));
    return {
      ...issue(ref, status), dependsOn: [...blockers.get(ref) ?? []].sort(order), jobs: under.flatMap((r) => jobsOf.get(graphId(r)) ?? []), ...updatedAt ? { updatedAt } : {},
    };
  };
  const piece = (ref: string): PlanPiece => {
    const below = kids(ref).filter((k) => !seen.has(k));
    for (const k of below) seen.add(k);
    const artifact = known.get(ref)?.artifact;
    const its = artifact ? { artifact } : {};
    if (below.length === 0) {
      const only = task(ref);
      return { ...issue(ref, only.status), tasks: [only], jobs: [], ...its };
    }
    const tasks = below.map(task);
    const own = ownStatus(ref);
    return { ...issue(ref, rollUpStatuses([...tasks.map((t) => t.status), ...own ? [own] : []])), tasks, jobs: jobsOf.get(graphId(ref)) ?? [], ...its };
  };
  const below = kids(root);
  for (const k of below) seen.add(k);
  // An issue with no sub-issues is a work plan of one plan piece, itself.
  const pieces = below.length ? below.map(piece) : [piece(root)];
  const own = below.length ? ownStatus(root) : undefined;
  const counts = Object.fromEntries(PLAN_STATUSES.map((s) => [s, 0])) as Record<PlanStatus, number>;
  for (const p of pieces) for (const t of p.tasks) counts[t.status] += 1;
  return {
    ...issue(root, rollUpStatuses([...pieces.map((p) => p.status), ...own ? [own] : []])),
    pieces, jobs: below.length ? jobsOf.get(graphId(root)) ?? [] : [], counts,
  };
}

/** The newest of some ISO times, or undefined when there are none. */
function newest(times: readonly (string | undefined)[]): string | undefined {
  let best: string | undefined;
  for (const t of times) if (t && !Number.isNaN(Date.parse(t)) && (best === undefined || Date.parse(t) > Date.parse(best))) best = t;
  return best;
}

/** Whether the issue graph's newest read of an issue says it closed as completed (or closed with no reason). */
function closedCompleted(n: GraphNode | undefined): boolean {
  if (!n || String(n.attrs.state ?? '').toUpperCase() !== 'CLOSED') return false;
  const reason = String(n.attrs.stateReason ?? '').toUpperCase();
  return reason === '' || reason === 'COMPLETED';
}
