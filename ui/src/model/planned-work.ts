// The Planned work tab of Jobs (issue #2840): one work plan (GET /api/planned-work) drawn left to right — the work plan,
// its plan pieces, their plan tasks, then each plan task's jobs —, each node coloured by its plan status, with the
// plan tasks' depends-on links. A click on a node opens a plan piece's artifact when it is a link, else the node's issue,
// or a job's view. The hash names the plan (#jobs/planned-work/<owner/name#n, encoded>), so a link opens it.
import { hierarchy, tree as d3tree } from 'd3';
import { jobHref } from './job.ts';
import type { Tone } from './jobs-view.ts';
import type { PlanStatus, WorkPlan } from './wire.ts';

/** Each plan status as the tab names and draws it: done a solid fill, running blue, planned dashed grey, blocked orange. */
export const STATUS_INFO: Record<PlanStatus, { label: string; tone: Tone; solid: boolean; dashed: boolean; title: string }> = {
  planned: { label: 'Planned', tone: 'muted', solid: false, dashed: true, title: 'no job works it yet' },
  running: { label: 'Running', tone: 'busy', solid: false, dashed: false, title: 'a job works it, or part of it is done' },
  done: { label: 'Done', tone: 'ok', solid: true, dashed: false, title: 'every job of it is done' },
  blocked: { label: 'Needs a person', tone: 'warn', solid: false, dashed: false, title: 'a job of it failed, or waits on a person' },
};
export const PLAN_STATUS_ORDER: readonly PlanStatus[] = ['planned', 'running', 'done', 'blocked'];

export type PlanNodeKind = 'plan' | 'piece' | 'task' | 'job';
const KIND_TEXT: Record<PlanNodeKind, string> = { plan: 'work plan', piece: 'plan piece', task: 'plan task', job: 'job' };
export const kindText = (k: PlanNodeKind): string => KIND_TEXT[k];

/**
 * One node as drawn: its top-left corner, its title, its issue ref (none for a job), its plan status (none for a job that
 * counts for nothing), the words under it, and what a click opens (`href`: a URL, or the job view's hash).
 */
export interface PlanNode {
  id: string; kind: PlanNodeKind; x: number; y: number; label: string; ref?: string; status?: PlanStatus; text: string; href: string; artifact?: string;
}
/** `part`: a node to one under it. `depends_on`: a plan task to a plan task that must come first. */
export interface PlanEdge { from: string; to: string; kind: 'part' | 'depends_on' }
export interface PlanLayout { nodes: PlanNode[]; edges: PlanEdge[]; width: number; height: number }

export const PLAN_NODE_W = 200;
export const PLAN_NODE_H = 50;
const COL = PLAN_NODE_W + 48;
const ROW = PLAN_NODE_H + 12;

/** A piece artifact that is a link opens; any other text is only shown. */
const linkOf = (artifact: string | undefined): string | undefined => (artifact && /^https?:\/\/\S+$/.test(artifact) ? artifact : undefined);

interface Draft { id: string; node: Omit<PlanNode, 'x' | 'y' | 'id'>; children: Draft[] }

/** The work plan laid out left to right (d3's tidy tree), in the API's order: each column one level. */
export function layoutPlan(plan: WorkPlan): PlanLayout {
  const issueNode = (kind: PlanNodeKind, i: { id: string; title: string; url: string; status: PlanStatus }, artifact?: string): Draft['node'] =>
    ({ kind, label: i.title, ref: i.id, status: i.status, text: STATUS_INFO[i.status].label, href: linkOf(artifact) ?? i.url, ...(artifact ? { artifact } : {}) });
  const root: Draft = {
    id: `plan:${plan.id}`, node: issueNode('plan', plan),
    children: plan.pieces.map((p) => ({
      id: `piece:${p.id}`, node: issueNode('piece', p, p.artifact),
      children: p.tasks.map((t) => ({
        id: `task:${t.id}`, node: issueNode('task', t),
        children: t.jobs.map((j) => ({
          id: `job:${t.id}:${j.id}`, children: [],
          node: { kind: 'job', label: `job ${j.id.slice(0, 8)}`, ...(j.planStatus ? { status: j.planStatus } : {}), text: j.stageText, href: jobHref(j.id) },
        })),
      })),
    })),
  };
  const laid = d3tree<Draft>().nodeSize([ROW, COL])(hierarchy(root, (d) => d.children));
  let minX = Infinity, maxX = -Infinity, maxY = 0;
  laid.each((n) => { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); });
  const nodes: PlanNode[] = [];
  const edges: PlanEdge[] = [];
  laid.eachBefore((n) => {
    nodes.push({ id: n.data.id, ...n.data.node, x: n.y, y: n.x - minX });
    for (const c of n.data.children) edges.push({ from: n.data.id, to: c.id, kind: 'part' });
  });
  for (const p of plan.pieces) for (const t of p.tasks) for (const d of t.dependsOn) {
    if (nodes.some((n) => n.id === `task:${d}`)) edges.push({ from: `task:${t.id}`, to: `task:${d}`, kind: 'depends_on' });
  }
  return { nodes, edges, width: maxY + PLAN_NODE_W, height: maxX - minX + PLAN_NODE_H };
}

const PREFIX = 'jobs/planned-work';
/** The hash that opens a work plan in the tab. */
export const planHash = (ref: string): string => `#${PREFIX}/${encodeURIComponent(ref)}`;
/** The work plan a hash names, or '' when it names none. */
export function planRefOf(hash: string): string {
  const h = hash.replace(/^#/, '');
  if (!h.startsWith(`${PREFIX}/`)) return '';
  try { return decodeURIComponent(h.slice(PREFIX.length + 1)); } catch { return ''; }
}

/** Where the work plan's export is read, as CSV or as nested JSON. */
export const exportPath = (ref: string, format: 'csv' | 'json'): string => `/api/planned-work/export?issue=${encodeURIComponent(ref)}&format=${format}`;
