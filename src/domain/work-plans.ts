// The plan store (issue #2861, design.md "Planned work"): a **work plan** kept in the hopper's database — its plan pieces,
// their plan tasks, the jobs linked to each, and its **plan artifacts** as records of their own. The store is where a work
// plan is read from; GitHub's sub-issues are one way to fill it: a **plan sync** imports the tree the issue graph holds,
// and does it again while the plan's sync is `github`. The hopper writes nothing to GitHub for a plan. Pure: the import
// takes the issue graph and the lineage links, and the repository is the store's.
import type { GraphEdge, GraphNode } from './issue-graph.ts';
import type { JobGraphLink } from './job-graph.ts';

/** Where a kept work plan's tree comes from: `github`, the plan sync imports it again from the issue graph; `off`, only the store has it. */
export const PLAN_SYNCS = ['github', 'off'] as const;
export type PlanSync = typeof PLAN_SYNCS[number];

/** What a plan artifact is: a job's pull request (the plan sync records it), or what a person added — a screenshot, a report or a link. */
export const PLAN_ARTIFACT_TYPES = ['pull_request', 'screenshot', 'report', 'link'] as const;
export type PlanArtifactType = typeof PLAN_ARTIFACT_TYPES[number];

/** The level a job link or an artifact is on. */
export type PlanLevel = 'plan' | 'piece' | 'task';

/** One issue of a kept tree: `owner/name#n` (lowercase repository), its title and URL. */
export interface KeptIssue { id: string; repo: string; number: number; title: string; url: string }

/** An issue a plan task counts the jobs of: its own first, then each sub-issue under it; `closed`: closed as completed at the last sync. */
export interface KeptTaskIssue { id: string; url: string; closed: boolean; updatedAt?: string }

/** A kept plan task: its issues and the issues that block it. */
export interface KeptTask extends KeptIssue { issues: KeptTaskIssue[]; dependsOn: string[] }

/** A kept plan piece: its plan tasks; a piece with no sub-issues is its own one plan task, with its id. */
export interface KeptPiece extends KeptIssue { tasks: KeptTask[] }

/** A kept tree: a work plan and its plan pieces; a work plan with no sub-issues is its own one plan piece, with its id. */
export interface PlanTree extends KeptIssue { pieces: KeptPiece[] }

/** A job linked to the plan, a plan piece or a plan task (`item`: its id). */
export interface PlanJobLink { level: PlanLevel; item: string; jobId: string }

/** A kept work plan. `syncedAt`: the last plan sync that changed or confirmed its tree. */
export interface KeptPlan extends PlanTree { sync: PlanSync; syncedAt?: string; createdAt: string; updatedAt: string; jobLinks: PlanJobLink[] }

/**
 * A plan artifact: what a person judges a plan piece or a plan task by. `ref`: a URL or a hopper artifact's id. `source`:
 * `sync` (a job's pull request the plan sync recorded) or `person` (`by` names them).
 */
export interface PlanArtifact {
  id: string; planId: string; pieceId: string; taskId?: string; jobId?: string; type: PlanArtifactType; ref: string;
  source: 'sync' | 'person'; by?: string; createdAt: string; updatedAt: string;
}

/** What a plan sync keeps: the tree, the jobs it found linked, and its jobs' pull requests as artifacts. */
export interface PlanSyncResult {
  tree: PlanTree; jobLinks: PlanJobLink[];
  pullRequests: { pieceId: string; taskId?: string; jobId: string; ref: string }[];
}

export interface WorkPlanRepository {
  /** Every kept work plan, by id. */
  list(): KeptPlan[];
  get(id: string): KeptPlan | undefined;
  /**
   * Keeps a plan sync's result in one transaction: the tree replaces the one kept (a new plan gets `sync`); the job links
   * and pull request artifacts are added to those kept, never removed. The kept plan after it.
   */
  keep(result: PlanSyncResult, sync: PlanSync, now: string): KeptPlan;
  /** Sets a kept plan's sync; false when no such plan is kept. */
  setSync(id: string, sync: PlanSync, now: string): boolean;
  /** Removes a kept plan, its job links and its artifacts; false when no such plan is kept. */
  remove(id: string): boolean;
  /** A plan's artifacts, oldest first. */
  artifacts(planId: string): PlanArtifact[];
  /** Adds an artifact; the same type and ref on the same piece and task again is answered the one kept, its `updatedAt` new. */
  addArtifact(a: Omit<PlanArtifact, 'id' | 'createdAt' | 'updatedAt'>, now: string): PlanArtifact;
  /** Removes an artifact of a plan; false when the plan holds no such one. */
  removeArtifact(planId: string, id: string): boolean;
}

/** The plan ref of an issue: `owner/name#n`, the repository lowercase, as the job graph's issue nodes name it. */
export const refOf = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`;

/** An issue's URL from its ref. */
const issueUrl = (ref: string): string => { const [repo, n] = ref.split('#'); return `https://github.com/${repo}/issues/${n}`; };

/** What the issue graph and the lineage links say of the issues: each one known, its sub-issues, and what blocks it. */
interface Tree {
  known: Map<string, { repo: string; number: number; url: string; title?: string; updatedAt?: string; closed: boolean }>;
  children: Map<string, Set<string>>;
  blockers: Map<string, Set<string>>;
}

function treeOf(issueGraph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] }, links: readonly JobGraphLink[]): Tree {
  // The issues the issue graph knows, by ref: their repository, number, title, URL and whether they closed as completed.
  const known: Tree['known'] = new Map();
  const byUrl = new Map<string, string>();
  for (const n of issueGraph.nodes) {
    if (n.kind !== 'issue' || typeof n.attrs.repo !== 'string' || typeof n.attrs.number !== 'number') continue;
    const ref = refOf(n.attrs.repo, n.attrs.number);
    const text = (k: string) => (typeof n.attrs[k] === 'string' && n.attrs[k] !== '' ? { [k]: n.attrs[k] } : {});
    known.set(ref, { repo: n.attrs.repo, number: n.attrs.number, url: n.id, closed: closedCompleted(n), ...text('title'), ...text('updatedAt') });
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
    if (!known.has(child)) known.set(child, { repo: l.child.repo, number: l.child.number, url: l.child.url ?? issueUrl(child), closed: false });
    add(children, refOf(l.parent.repo, l.parent.number), child);
  }
  return { known, children, blockers };
}

/**
 * The tree of the work plan whose root issue is `root`, as the issue graph and the lineage links hold it: undefined when
 * they know no such issue. Its plan pieces are the root's sub-issues, their plan tasks theirs, and a plan task holds every
 * issue under it, once each. Deterministic: sub-issues in the order of their repository and number.
 */
export function planFromIssueGraph(
  root: { repo: string; number: number }, issueGraph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] }, links: readonly JobGraphLink[],
): PlanTree | undefined {
  const { known, children, blockers } = treeOf(issueGraph, links);
  const start = refOf(root.repo, root.number);
  if (!known.has(start) && !children.has(start)) return undefined;
  const order = (a: string, b: string): number => {
    const x = known.get(a), y = known.get(b);
    return (x?.repo.toLowerCase() ?? a).localeCompare(y?.repo.toLowerCase() ?? b) || (x?.number ?? 0) - (y?.number ?? 0);
  };
  const kids = (ref: string): string[] => [...children.get(ref) ?? []].sort(order);
  const issue = (ref: string): KeptIssue => {
    const k = known.get(ref);
    const [repo = '', n = '0'] = ref.split('#');
    return { id: ref, repo: k?.repo ?? (ref === start ? root.repo : repo), number: k?.number ?? Number(n), title: k?.title ?? ref, url: k?.url ?? issueUrl(ref) };
  };
  const taskIssue = (ref: string): KeptTaskIssue => {
    const k = known.get(ref);
    return { id: ref, url: k?.url ?? issueUrl(ref), closed: k?.closed ?? false, ...k?.updatedAt ? { updatedAt: k.updatedAt } : {} };
  };
  const seen = new Set<string>([start]);
  const task = (ref: string): KeptTask => {
    const under = [ref];
    for (let i = 0; i < under.length; i++) for (const k of kids(under[i]!)) if (!seen.has(k)) { seen.add(k); under.push(k); }
    return { ...issue(ref), issues: under.map(taskIssue), dependsOn: [...blockers.get(ref) ?? []].sort(order) };
  };
  const piece = (ref: string): KeptPiece => {
    const below = kids(ref).filter((k) => !seen.has(k));
    for (const k of below) seen.add(k);
    return { ...issue(ref), tasks: below.length === 0 ? [task(ref)] : below.map(task) };
  };
  const below = kids(start);
  for (const k of below) seen.add(k);
  // An issue with no sub-issues is a work plan of one plan piece, itself.
  return { ...issue(start), pieces: below.length ? below.map(piece) : [piece(start)] };
}

/** Every issue of a tree, by ref, with the level and item whose jobs it counts for: what a plan sync links jobs through. */
export function issuesOfTree(tree: PlanTree): { level: PlanLevel; item: string; pieceId: string; taskId?: string; ref: string; url: string }[] {
  const out: ReturnType<typeof issuesOfTree> = [];
  if (!tree.pieces.some((p) => p.id === tree.id)) out.push({ level: 'plan', item: tree.id, pieceId: tree.id, ref: tree.id, url: tree.url });
  for (const p of tree.pieces) {
    if (!p.tasks.some((t) => t.id === p.id)) out.push({ level: 'piece', item: p.id, pieceId: p.id, ref: p.id, url: p.url });
    for (const t of p.tasks) for (const i of t.issues) out.push({ level: 'task', item: t.id, pieceId: p.id, taskId: t.id, ref: i.id, url: i.url });
  }
  return out;
}

/** Whether the issue graph's newest read of an issue says it closed as completed (or closed with no reason). */
function closedCompleted(n: GraphNode): boolean {
  if (String(n.attrs.state ?? '').toUpperCase() !== 'CLOSED') return false;
  const reason = String(n.attrs.stateReason ?? '').toUpperCase();
  return reason === '' || reason === 'COMPLETED';
}
