// The job page's model (issue #935): a job's parts list (GET /api/jobs/:id/bom) filtered by group, status and text; what
// waits on the person, pinned at the top; and the job's own graph, laid out left to right from the job through each
// group to its parts (d3's tidy tree).
import { hierarchy, tree as d3tree } from 'd3';
import type { Tone } from './jobs-view.ts';
import type { BomGroup, BomPart, BomStatus, JobBom } from './wire.ts';

/** Each group in plain words, in the order the parts list shows them. */
export const BOM_GROUP_TEXT: Record<BomGroup, string> = {
  asked: 'What was asked', work: 'Work', code: 'Code', outputs: 'Outputs', infra: 'Infra', decisions: 'Decisions', machines: 'Machines and sandboxes',
};
export const BOM_GROUP_ORDER = Object.keys(BOM_GROUP_TEXT) as BomGroup[];

/** Each status in plain words, and its colour. */
export const BOM_STATUS: Record<BomStatus, { label: string; tone: Tone }> = {
  waiting_on_you: { label: 'waiting on you', tone: 'question' }, running: { label: 'running', tone: 'busy' }, open: { label: 'open', tone: 'warn' },
  done: { label: 'done', tone: 'ok' }, failed: { label: 'failed', tone: 'bad' }, cancelled: { label: 'cancelled', tone: 'muted' }, recorded: { label: 'recorded', tone: 'muted' },
};

/** The parts list's filters: `null` and the empty text show every part. */
export interface BomFilter { group: BomGroup | null; status: BomStatus | null; text: string }
export const NO_BOM_FILTER: BomFilter = { group: null, status: null, text: '' };

/** The parts the filter lets through, in the parts list's order: what waits on the person first. */
export function bomRows(bom: JobBom, f: BomFilter): BomPart[] {
  const text = f.text.trim().toLowerCase();
  return bom.parts.filter((p) => (f.group === null || p.group === f.group) && (f.status === null || p.status === f.status)
    && (text === '' || `${p.label} ${p.detail ?? ''}`.toLowerCase().includes(text)));
}

/** The parts that wait on the person: pinned at the top of the job page. */
export const waitingParts = (bom: JobBom): BomPart[] => bom.parts.filter((p) => p.status === 'waiting_on_you');

export interface BomPlaced { id: string; x: number; y: number }
export interface BomLayout { placed: BomPlaced[]; links: { from: string; to: string }[]; width: number; height: number }

export const BOM_NODE_W = 210;
export const BOM_NODE_H = 40;
const COL = BOM_NODE_W + 48;
const ROW = BOM_NODE_H + 10;

/** The job's own graph: `job`, then `group:<group>` for each group it has, then `part:<id>` for each part under its group. */
export function layoutBom(bom: JobBom): BomLayout {
  type Node = { id: string; children?: Node[] };
  const groups: Node[] = BOM_GROUP_ORDER.filter((g) => bom.parts.some((p) => p.group === g))
    .map((g) => ({ id: `group:${g}`, children: bom.parts.filter((p) => p.group === g).map((p) => ({ id: `part:${p.id}` })) }));
  const laid = d3tree<Node>().nodeSize([ROW, COL])(hierarchy<Node>({ id: 'job', children: groups }));
  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = 0;
  laid.each((n) => { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); });
  const placed: BomPlaced[] = [];
  const links: { from: string; to: string }[] = [];
  laid.each((n) => {
    placed.push({ id: n.data.id, x: n.y, y: n.x - minX });
    if (n.parent) links.push({ from: n.parent.data.id, to: n.data.id });
  });
  return { placed, links, width: maxY + BOM_NODE_W, height: maxX - minX + BOM_NODE_H };
}
