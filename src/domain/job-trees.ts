// The job trees of the job graph (issue #900): each group of connected nodes, its root, what blocks the root, and the count
// of its jobs in each stage. Split from job-graph.ts. Pure.
import type { JobGraphEdge, JobGraphNode, JobGraphNodeKind, JobStage, JobTree } from './job-graph.ts';

/** The stages that block nothing. */
const SETTLED: readonly JobStage[] = ['done', 'cancelled', 'superseded'];

export const countStages = (nodes: readonly JobGraphNode[]): Partial<Record<JobStage, number>> => {
  const out: Partial<Record<JobStage, number>> = {};
  for (const n of nodes) if (n.kind === 'job') out[n.stage] = (out[n.stage] ?? 0) + 1;
  return out;
};

/** Root order: an issue before a job before a pull request, then by id. */
const KIND_RANK: Record<JobGraphNodeKind, number> = { issue: 0, job: 1, pull_request: 2, question: 3, handoff: 4 };

/**
 * The job trees: each group of connected nodes, rooted at a node no edge leads into (an issue first), else at its first
 * node. `blocking`: the root's unsettled descendants and every node on a way from the root to one.
 */
export function treesOf(nodes: readonly JobGraphNode[], edges: readonly JobGraphEdge[]): Omit<JobTree, 'summary'>[] {
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
  const trees: Omit<JobTree, 'summary'>[] = [];
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
