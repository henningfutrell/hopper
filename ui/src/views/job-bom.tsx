// The job page's parts list (issue #935): what GET /api/jobs/:id/bom answers, read when the page opens and again each
// time the job has a new event, so running parts stay live. A plain-words header (what was asked, where it stands, what
// is next) with the job's summary; what waits on the person, pinned at the top; the job's own graph, a node per part
// under its group; and the parts as a table, filtered by group, status and text. Each part links to its own page.
import { useEffect, useMemo, useState } from 'react';
import { FitGraph } from '@/components/fit-graph';
import { GhLink } from '@/components/job';
import { Empty } from '@/components/panel';
import { FIELD } from '@/components/plugin-form';
import { COLOR, StatusBadge, TEXT } from '@/components/status';
import { get } from '@/lib/api';
import { cn } from '@/lib/utils';
import { BOM_GROUP_ORDER, BOM_GROUP_TEXT, BOM_NODE_H, BOM_NODE_W, BOM_STATUS, bomRows, layoutBom, NO_BOM_FILTER, waitingParts, type BomFilter } from '@/model/job-bom';
import type { BomPart, BomStatus, JobBom } from '@/model/wire';
import { useHopper } from '@/store';

/** The job's parts list; read again (debounced) when an event of the job arrives. `null` while unread or when there is none. */
export function useJobBom(id: string): JobBom | null {
  const lastSeq = useHopper((s) => s.events.reduce((m, e) => (e.jobId === id && e.seq > m ? e.seq : m), 0));
  const [bom, setBom] = useState<{ id: string; bom: JobBom } | null>(null);
  useEffect(() => {
    let live = true;
    const soon = setTimeout(() => {
      get<JobBom>(`/api/jobs/${encodeURIComponent(id)}/bom`).then((b) => { if (live) setBom({ id, bom: b }); }, () => {});
    }, lastSeq ? 150 : 0);
    return () => { live = false; clearTimeout(soon); };
  }, [id, lastSeq]);
  return bom?.id === id ? bom.bom : null;
}

function PartLink({ part }: { part: BomPart }) {
  if (part.href) return <a href={part.href} className="underline-offset-4 hover:underline">{part.label}</a>;
  if (part.url) return <GhLink url={part.url} className="text-foreground">{part.label}</GhLink>;
  return <span>{part.label}</span>;
}

const StatusOf = ({ status }: { status: BomStatus }) => <StatusBadge status={status} label={BOM_STATUS[status].label} tone={BOM_STATUS[status].tone} />;

export function JobHeader({ bom }: { bom: JobBom }) {
  const row = (slot: string, label: string, text: string, className?: string) => (
    <div data-slot={slot} className="flex gap-2 text-sm"><span className="w-28 shrink-0 text-muted-foreground">{label}</span><span className={cn('min-w-0 break-words', className)}>{text}</span></div>
  );
  return (
    <div data-slot="job-header" className="space-y-1">
      {row('job-header-asked', 'What was asked', bom.header.asked, 'font-medium')}
      {row('job-header-stands', 'Where it stands', bom.header.stands)}
      {row('job-header-next', 'What is next', bom.header.next)}
      <p data-slot="job-summary" className="pt-1 text-xs text-muted-foreground">{bom.summary}</p>
    </div>
  );
}

/** What waits on the person, pinned at the top of the page; nothing when nothing waits. */
export function WaitingPinned({ bom }: { bom: JobBom }) {
  const parts = waitingParts(bom);
  if (!parts.length) return null;
  return (
    <div data-slot="job-waiting" className="space-y-1 rounded-lg border border-question/40 bg-question/5 px-3 py-2">
      <div className={cn('text-xs font-medium', TEXT.question)}>Waiting on you</div>
      {parts.map((p) => (
        <div key={p.id} className="flex min-w-0 items-baseline gap-2 text-sm">
          <span className="shrink-0 text-xs text-muted-foreground">{BOM_GROUP_TEXT[p.group]}</span>
          <span className="min-w-0 flex-1 truncate"><PartLink part={p} /></span>
          {p.detail && <span className="min-w-0 truncate text-xs text-muted-foreground">{p.detail}</span>}
        </div>
      ))}
    </div>
  );
}

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The job's own graph: the job, a node per group it has, and a node per part under its group. */
export function BomGraph({ bom, title }: { bom: JobBom; title: string }) {
  const layout = useMemo(() => layoutBom(bom), [bom]);
  const at = useMemo(() => new Map(layout.placed.map((p) => [p.id, p])), [layout]);
  const parts = useMemo(() => new Map(bom.parts.map((p) => [`part:${p.id}`, p])), [bom]);
  const PAD = 8;
  return (
    <FitGraph slot="bom-graph" label="the job's parts" width={layout.width + 2 * PAD} height={layout.height + 2 * PAD}>
        <g transform={`translate(${PAD},${PAD})`}>
          {layout.links.map((l) => {
            const a = at.get(l.from)!;
            const b = at.get(l.to)!;
            const [x1, y1, x2, y2] = [a.x + BOM_NODE_W, a.y + BOM_NODE_H / 2, b.x, b.y + BOM_NODE_H / 2];
            const mid = (x1 + x2) / 2;
            return <path key={`${l.from} ${l.to}`} d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} fill="none" stroke="var(--muted-foreground)" strokeOpacity={0.45} strokeWidth={1.25} />;
          })}
          {layout.placed.map((p) => {
            const part = parts.get(p.id);
            const tone = part ? BOM_STATUS[part.status].tone : 'muted';
            const label = part ? part.label : p.id === 'job' ? title : BOM_GROUP_TEXT[p.id.slice('group:'.length) as keyof typeof BOM_GROUP_TEXT];
            const sub = part ? `${BOM_STATUS[part.status].label}${part.detail ? ` · ${part.detail}` : ''}` : p.id === 'job' ? 'this job' : `${bom.parts.filter((x) => `group:${x.group}` === p.id).length} parts`;
            const box = (
              <g key={p.id} data-slot={part ? 'bom-node' : 'bom-group'} data-part-id={part?.id} data-status={part?.status} transform={`translate(${p.x},${p.y})`}>
                <title>{`${label}\n${sub}`}</title>
                <rect width={BOM_NODE_W} height={BOM_NODE_H} rx={part ? 6 : 10} fill="var(--card)" stroke={COLOR[tone]} strokeWidth={part?.status === 'waiting_on_you' ? 2 : 1.25} />
                <rect width={4} height={BOM_NODE_H} rx={2} fill={COLOR[tone]} />
                <text x={10} y={16} fontSize={11} fill="var(--foreground)" fontWeight={part ? 400 : 600}>{short(label, 30)}</text>
                <text x={10} y={31} fontSize={10} fill={COLOR[tone]}>{short(sub, 34)}</text>
              </g>
            );
            return part?.href ? <a key={p.id} href={part.href}>{box}</a> : box;
          })}
        </g>
    </FitGraph>
  );
}

/** The parts as a table, filtered by group, status and text. */
export function BomTable({ bom }: { bom: JobBom }) {
  const [filter, setFilter] = useState<BomFilter>(NO_BOM_FILTER);
  const rows = bomRows(bom, filter);
  const groups = BOM_GROUP_ORDER.filter((g) => bom.parts.some((p) => p.group === g));
  const statuses = (Object.keys(BOM_STATUS) as BomStatus[]).filter((s) => bom.parts.some((p) => p.status === s));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <label className="flex items-center gap-1.5">Group
          <select data-slot="bom-filter-group" className={cn(FIELD, 'w-44')} value={filter.group ?? ''} onChange={(e) => setFilter((f) => ({ ...f, group: (e.target.value || null) as BomFilter['group'] }))}>
            <option value="">all</option>
            {groups.map((g) => <option key={g} value={g}>{BOM_GROUP_TEXT[g]}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5">Status
          <select data-slot="bom-filter-status" className={cn(FIELD, 'w-36')} value={filter.status ?? ''} onChange={(e) => setFilter((f) => ({ ...f, status: (e.target.value || null) as BomFilter['status'] }))}>
            <option value="">all</option>
            {statuses.map((s) => <option key={s} value={s}>{BOM_STATUS[s].label}</option>)}
          </select>
        </label>
        <input data-slot="bom-filter-text" className={cn(FIELD, 'w-52')} placeholder="Find a part" value={filter.text} onChange={(e) => setFilter((f) => ({ ...f, text: e.target.value }))} />
        <span className="num">{rows.length === bom.parts.length ? `${rows.length} parts` : `${rows.length} of ${bom.parts.length} parts`}</span>
      </div>
      {rows.length ? (
        <table data-slot="bom-table" className="w-full text-left text-xs">
          <thead className="text-muted-foreground"><tr><th className="py-1 pr-3 font-normal">Group</th><th className="py-1 pr-3 font-normal">Part</th><th className="py-1 pr-3 font-normal">Status</th><th className="py-1 font-normal">Detail</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} data-slot="bom-row" data-part-id={p.id} data-group={p.group} data-status={p.status} className="border-t align-top">
                <td className="py-1 pr-3 text-muted-foreground">{BOM_GROUP_TEXT[p.group]}</td>
                <td className="py-1 pr-3 break-words"><PartLink part={p} /></td>
                <td className="py-1 pr-3"><StatusOf status={p.status} /></td>
                <td className="py-1 break-words text-muted-foreground">{p.detail ?? ''}{p.at ? <span className="ml-2 font-mono text-muted-foreground/70">{p.at.slice(0, 16).replace('T', ' ')}</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <table data-slot="bom-table" className="w-full"><tbody><tr><td><Empty>No part matches the filters.</Empty></td></tr></tbody></table>}
    </div>
  );
}
