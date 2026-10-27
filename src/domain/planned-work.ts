// Planned work (issues #2840, #2861, design.md "Planned work"): a **work plan** kept in the plan store, broken down into
// **plan pieces** and **plan tasks**, each tied to its jobs — the job graph's jobs of its issues and the jobs linked to it
// in the store —, with where each stands rolled up from those jobs, and each piece's and task's **plan artifacts**. The
// store holds the tree, the links and the artifacts; the jobs and their stages are the job graph's, read, never copied.
// Pure: the route reads the kept plan, its artifacts and the job graph, and passes them in.
import { issueNodeId, type JobGraph, type JobGraphNode, type JobStage } from './job-graph.ts';
import type { JobStatus } from './types.ts';
import type { KeptPlan, KeptTask, PlanArtifact, PlanLevel, PlanSync } from './work-plans.ts';

/** Where a plan task, a plan piece or a work plan stands. */
export const PLAN_STATUSES = ['planned', 'running', 'done', 'blocked'] as const;
export type PlanStatus = typeof PLAN_STATUSES[number];

/**
 * A job of a plan task, as the job graph has it: read, never copied. `planStatus`: its part in the roll-up; absent when it
 * counts for nothing (superseded or cancelled).
 */
export interface PlanJob { id: string; status: JobStatus; stage: JobStage; stageText: string; pullRequest?: string; planStatus?: PlanStatus }

/** A plan artifact as a work plan shows it, on its plan piece or plan task. */
export type PlanArtifactView = Omit<PlanArtifact, 'planId' | 'pieceId' | 'taskId'>;

/** One issue of the tree: `owner/name#n` (lowercase repository), its title, its URL and where it stands. */
interface PlanIssue { id: string; repo: string; number: number; title: string; url: string; status: PlanStatus }

/**
 * A plan task: its jobs (and its own sub-issues' jobs), the issues that block it, its artifacts, and when it changed last:
 * the newest of its issues' updates and its jobs' stage changes.
 */
export interface PlanTask extends PlanIssue { dependsOn: string[]; jobs: PlanJob[]; artifacts: PlanArtifactView[]; updatedAt?: string }

/** A plan piece: its plan tasks, the jobs of its own issue, and its own artifacts (its plan tasks' are theirs). */
export interface PlanPiece extends PlanIssue { tasks: PlanTask[]; jobs: PlanJob[]; artifacts: PlanArtifactView[] }

/** A work plan: its plan pieces, the jobs of its own issue, how many of its plan tasks are in each status, and its sync. */
export interface WorkPlan extends PlanIssue {
  sync: PlanSync; syncedAt?: string; pieces: PlanPiece[]; jobs: PlanJob[]; counts: Record<PlanStatus, number>;
}

/** A kept work plan in a list: its roll-up without the tree. */
export type WorkPlanSummary = Omit<WorkPlan, 'pieces' | 'jobs'> & { pieces: number; tasks: number };

export interface PlannedWorkInput { plan: KeptPlan; artifacts: readonly PlanArtifact[]; graph: JobGraph }

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

const planJobOf = (n: JobGraphNode): PlanJob => {
  const s = jobStatus(n);
  return { id: n.jobId!, status: n.status!, stage: n.stage, stageText: n.stageText, ...(n.pullRequest ? { pullRequest: n.pullRequest.url } : {}), ...s ? { planStatus: s } : {} };
};

/** The graph node id of an issue ref (`owner/name#n`). */
const graphIdOf = (ref: string): string => { const i = ref.lastIndexOf('#'); return issueNodeId(ref.slice(0, i), Number(ref.slice(i + 1))); };

const viewOf = ({ planId: _p, pieceId: _i, taskId: _t, ...a }: PlanArtifact): PlanArtifactView => a;

/** The work plan of a kept plan, rolled up from its jobs. Pieces and tasks in the store's order. */
export function plannedWork(input: PlannedWorkInput): WorkPlan {
  const { plan } = input;
  const nodes = new Map(input.graph.nodes.map((n) => [n.id, n]));
  const byJob = new Map(input.graph.nodes.filter((n) => n.jobId && n.status).map((n) => [n.jobId!, n]));
  // The job graph's jobs of each issue.
  const worked = new Map<string, JobGraphNode[]>();
  for (const e of input.graph.edges) {
    const job = e.kind === 'works' ? nodes.get(e.to) : undefined;
    if (job?.jobId && job.status) worked.set(e.from, [...worked.get(e.from) ?? [], job]);
  }
  const linked = new Map<string, string[]>();
  for (const l of plan.jobLinks) linked.set(`${l.level} ${l.item}`, [...linked.get(`${l.level} ${l.item}`) ?? [], l.jobId]);
  /** The jobs of some issues and of the links of one item, once each, in the graph's order then the links'. */
  const jobsOf = (refs: readonly string[], level: PlanLevel, item: string): JobGraphNode[] => {
    const out = new Map<string, JobGraphNode>();
    for (const r of refs) for (const n of worked.get(graphIdOf(r)) ?? []) out.set(n.jobId!, n);
    for (const id of linked.get(`${level} ${item}`) ?? []) { const n = byJob.get(id); if (n && !out.has(id)) out.set(id, n); }
    return [...out.values()];
  };
  const counted = (js: readonly JobGraphNode[]): PlanStatus | undefined => {
    const s = js.map(jobStatus).filter((x): x is PlanStatus => x !== undefined);
    return s.length ? rollUpStatuses(s) : undefined;
  };
  const artifactsOf = (pieceId: string, taskId?: string): PlanArtifactView[] =>
    input.artifacts.filter((a) => a.pieceId === pieceId && a.taskId === taskId).map(viewOf);

  const task = (pieceId: string, t: KeptTask): PlanTask => {
    const js = jobsOf(t.issues.map((i) => i.id), 'task', t.id);
    // With no job that counts, a task is done when each of its issues is: its item done, or closed as completed.
    const settled = t.issues.every((i) => i.closed || nodes.get(graphIdOf(i.id))?.stage === 'done');
    const status = counted(js) ?? (settled ? 'done' : 'planned');
    const updatedAt = newest([...t.issues.map((i) => i.updatedAt), ...js.map((n) => n.stageSince)]);
    return {
      id: t.id, repo: t.repo, number: t.number, title: t.title, url: t.url, status, dependsOn: t.dependsOn, jobs: js.map(planJobOf),
      artifacts: artifactsOf(pieceId, t.id), ...updatedAt ? { updatedAt } : {},
    };
  };
  const pieces: PlanPiece[] = plan.pieces.map((p) => {
    const tasks = p.tasks.map((t) => task(p.id, t));
    // A piece that is its own one task has no jobs of its own: the task has them.
    const own = tasks.some((t) => t.id === p.id) ? [] : jobsOf([p.id], 'piece', p.id);
    const ownStatus = counted(own);
    return {
      id: p.id, repo: p.repo, number: p.number, title: p.title, url: p.url, status: rollUpStatuses([...tasks.map((t) => t.status), ...ownStatus ? [ownStatus] : []]),
      tasks, jobs: own.map(planJobOf), artifacts: artifactsOf(p.id),
    };
  });
  const own = pieces.some((p) => p.id === plan.id) ? [] : jobsOf([plan.id], 'plan', plan.id);
  const ownStatus = counted(own);
  const counts = Object.fromEntries(PLAN_STATUSES.map((s) => [s, 0])) as Record<PlanStatus, number>;
  for (const p of pieces) for (const t of p.tasks) counts[t.status] += 1;
  return {
    id: plan.id, repo: plan.repo, number: plan.number, title: plan.title, url: plan.url,
    status: rollUpStatuses([...pieces.map((p) => p.status), ...ownStatus ? [ownStatus] : []]),
    sync: plan.sync, ...plan.syncedAt ? { syncedAt: plan.syncedAt } : {}, pieces, jobs: own.map(planJobOf), counts,
  };
}

/** A work plan in a list. */
export function workPlanSummary({ pieces, jobs: _, ...p }: WorkPlan): WorkPlanSummary {
  return { ...p, pieces: pieces.length, tasks: pieces.reduce((n, x) => n + x.tasks.length, 0) };
}

/** The newest of some ISO times, or undefined when there are none. */
function newest(times: readonly (string | undefined)[]): string | undefined {
  let best: string | undefined;
  for (const t of times) if (t && !Number.isNaN(Date.parse(t)) && (best === undefined || Date.parse(t) > Date.parse(best))) best = t;
  return best;
}
