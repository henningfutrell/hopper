// The plan sync (issue #2861, design.md "Planned work"): a work plan's tree imported into the plan store from the issue
// graph — GitHub's sub-issues as the GitHub sources keep them, and the required children jobs filed —, the newest job of
// each of its issues linked to it, and each linked job's pull request kept as a plan artifact. Import runs it once; the
// pass runs it again every PLAN_SYNC_EVERY_MS, on the host that holds its lease, for each plan whose sync is `github`. It
// reads only the database: no GitHub read, and nothing is written to GitHub. A plan whose sync is `off` keeps its tree.
import type { GraphEdge, GraphNode } from '../domain/issue-graph.ts';
import { pullRequestOf, type JobGraphLink } from '../domain/job-graph.ts';
import type { UserStore } from '../domain/store.ts';
import { issuesOfTree, planFromIssueGraph, type KeptPlan, type PlanSync, type PlanSyncResult } from '../domain/work-plans.ts';

export const PLAN_SYNC_EVERY_MS = 5 * 60_000;
/** The lineage links read. */
const LINKS = 5000;

/** The required-child and other lineage links jobs filed (`job.child_issue_filed`), newest first: the job graph's too. */
export function lineageLinks(store: Pick<UserStore, 'events'>): JobGraphLink[] {
  return store.events.recent(LINKS, ['job.child_issue_filed']).map((e) => e.data as unknown as JobGraphLink)
    .filter((l) => typeof l.parent?.repo === 'string' && typeof l.parent.number === 'number' && typeof l.child?.repo === 'string' && typeof l.child.number === 'number');
}

/** One read of the issue graph and the lineage links, shared by the plans of a pass. */
interface GraphRead { nodes: GraphNode[]; edges: GraphEdge[]; links: JobGraphLink[] }

const readOf = (store: UserStore): GraphRead => ({ nodes: store.issueGraph.nodes(), edges: store.issueGraph.edges(), links: lineageLinks(store) });

/** What a plan sync of the work plan whose root is `root` keeps; undefined when the issue graph and the lineage links know no such issue. */
export function planSyncOf(store: UserStore, root: { repo: string; number: number }, read: GraphRead = readOf(store)): PlanSyncResult | undefined {
  const tree = planFromIssueGraph(root, read, read.links);
  if (!tree) return undefined;
  const jobLinks: PlanSyncResult['jobLinks'] = [];
  const pullRequests: PlanSyncResult['pullRequests'] = [];
  for (const i of issuesOfTree(tree)) {
    const job = store.jobs.getBySourceKey(i.url);
    if (!job) continue;
    jobLinks.push({ level: i.level, item: i.item, jobId: job.id });
    const pr = pullRequestOf(job);
    if (pr) pullRequests.push({ pieceId: i.pieceId, ...(i.taskId ? { taskId: i.taskId } : {}), jobId: job.id, ref: pr.url });
  }
  return { tree, jobLinks, pullRequests };
}

/** Imports or syncs one work plan; undefined when the issue graph knows no such issue. A new plan gets `sync`; a kept one keeps its own. */
export function syncPlan(store: UserStore, root: { repo: string; number: number }, sync: PlanSync, now: Date, read?: GraphRead): KeptPlan | undefined {
  const result = planSyncOf(store, root, read);
  return result ? store.workPlans.keep(result, sync, now.toISOString()) : undefined;
}

/** The pass: every kept plan whose sync is `github`, synced again from one read of the issue graph. How many it synced. */
export function syncWorkPlans(store: UserStore, now: Date): number {
  const plans = store.workPlans.list().filter((p) => p.sync === 'github');
  if (plans.length === 0) return 0;
  const read = readOf(store);
  let n = 0;
  for (const p of plans) if (syncPlan(store, p, 'github', now, read)) n += 1;
  return n;
}
