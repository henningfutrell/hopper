// The Planned work tab of Jobs (issue #2840): one work plan, named by its issue, drawn left to right — the work plan, its
// plan pieces, their plan tasks, then the jobs — each node coloured by its plan status (done a solid fill, running blue,
// planned dashed grey, needs a person orange), with a bar of how many plan tasks are in each status above it and the
// plan tasks' depends-on links dashed. A click on a node opens a plan piece's artifact when it is a link, else its issue,
// or a job's view. Export saves the plan as CSV (a row per plan task) or as nested JSON. Read again each time the store's
// jobs change, as the Jobs tab is.
import { Download, ListTree } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { FitGraph } from '@/components/fit-graph';
import { Empty, Panel } from '@/components/panel';
import { COLOR, TEXT } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { download, get } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  exportPath, kindText, layoutPlan, PLAN_NODE_H, PLAN_NODE_W, PLAN_STATUS_ORDER, planHash, planRefOf, STATUS_INFO, type PlanNode,
} from '@/model/planned-work';
import type { WorkPlan } from '@/model/wire';
import { useHopper } from '@/store';

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const subscribe = (fn: () => void) => { window.addEventListener('hashchange', fn); return () => window.removeEventListener('hashchange', fn); };
const usePlanRef = (): string => useSyncExternalStore(subscribe, () => planRefOf(window.location.hash));

function open(n: PlanNode) {
  if (n.href.startsWith('#')) window.location.hash = n.href;
  else window.open(n.href, '_blank', 'noopener');
}

function NodeBox({ n }: { n: PlanNode }) {
  const info = n.status ? STATUS_INFO[n.status] : undefined;
  const color = info ? COLOR[info.tone] : 'var(--muted-foreground)';
  const ink = info?.solid ? 'var(--background)' : 'var(--foreground)';
  return (
    <g data-slot="plan-node" data-node-id={n.id} data-kind={n.kind} data-status={n.status ?? 'none'} transform={`translate(${n.x},${n.y})`}
      className="cursor-pointer" role="link" tabIndex={0} aria-label={`${kindText(n.kind)} ${n.label}, ${n.text}`}
      onClick={() => open(n)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(n); } }}>
      <title>{`${n.label}${n.ref ? ` (${n.ref})` : ''}\n${kindText(n.kind)} · ${n.text}${n.artifact ? `\nartifact: ${n.artifact}` : ''}`}</title>
      <rect width={PLAN_NODE_W} height={PLAN_NODE_H} rx={n.kind === 'job' ? 10 : 6} fill={info?.solid ? color : 'var(--card)'}
        stroke={color} strokeWidth={1.25} strokeDasharray={info?.dashed ? '4 3' : undefined} />
      <text x={10} y={16} fontSize={11} fill={ink} fontWeight={500}>{short(n.label, 30)}</text>
      <text x={10} y={30} fontSize={9} fill={info?.solid ? ink : 'var(--muted-foreground)'} fontFamily="var(--font-mono, monospace)">{`${n.ref ? `${n.ref} · ` : ''}${kindText(n.kind)}`}</text>
      <text data-slot="plan-node-status" x={10} y={43} fontSize={10} fill={info?.solid ? ink : color}>{short(n.artifact ? `${n.text} · ${n.artifact}` : n.text, 34)}</text>
    </g>
  );
}

function PlanGraph({ plan }: { plan: WorkPlan }) {
  const l = useMemo(() => layoutPlan(plan), [plan]);
  const at = useMemo(() => new Map(l.nodes.map((n) => [n.id, n])), [l]);
  const PAD = 8, BEND = 36;
  return (
    <FitGraph slot="planned-work-graph" label="work plan" width={l.width + 2 * PAD + BEND} height={l.height + 2 * PAD}>
      <g transform={`translate(${PAD},${PAD})`}>
        {l.edges.map((e) => {
          const a = at.get(e.from)!, b = at.get(e.to)!;
          const [ya, yb] = [a.y + PLAN_NODE_H / 2, b.y + PLAN_NODE_H / 2];
          // A part: from the right of a node to the left of the one under it. Depends on: a dashed bow to the right.
          const d = e.kind === 'part'
            ? `M${a.x + PLAN_NODE_W},${ya} C${(a.x + PLAN_NODE_W + b.x) / 2},${ya} ${(a.x + PLAN_NODE_W + b.x) / 2},${yb} ${b.x},${yb}`
            : `M${a.x + PLAN_NODE_W},${ya} C${a.x + PLAN_NODE_W + BEND},${ya} ${b.x + PLAN_NODE_W + BEND},${yb} ${b.x + PLAN_NODE_W},${yb}`;
          return (
            <path key={`${e.from} ${e.kind} ${e.to}`} data-slot="plan-edge" data-kind={e.kind} d={d} fill="none"
              stroke={e.kind === 'part' ? 'var(--muted-foreground)' : 'var(--warn)'} strokeOpacity={0.6} strokeWidth={1.25} strokeDasharray={e.kind === 'part' ? undefined : '3 3'}>
              {e.kind === 'depends_on' && <title>{`${a.label} depends on ${b.label}`}</title>}
            </path>
          );
        })}
        {l.nodes.map((n) => <NodeBox key={n.id} n={n} />)}
      </g>
    </FitGraph>
  );
}

function Counts({ plan }: { plan: WorkPlan }) {
  return (
    <div data-slot="planned-work-counts" className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs">
      <span className="text-muted-foreground">Plan tasks:</span>
      {PLAN_STATUS_ORDER.map((s) => (
        <span key={s} data-slot="planned-work-count" data-status={s} title={STATUS_INFO[s].title} className={TEXT[STATUS_INFO[s].tone]}>
          <span className="num font-medium">{plan.counts[s]}</span> {STATUS_INFO[s].label.toLowerCase()}
        </span>
      ))}
    </div>
  );
}

function Legend() {
  return (
    <div data-slot="planned-work-legend" className="flex flex-wrap gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground">
      <span>solid fill: done</span><span className={TEXT.busy}>blue: running</span><span>dashed grey: planned</span>
      <span className={TEXT.warn}>orange: needs a person</span><span className={TEXT.warn}>dashed orange line: depends on</span>
      <span>click a node to open its artifact, issue or job</span>
    </div>
  );
}

/** The tab: the work plan the hash names, its state new for each plan. */
export function PlannedWork() {
  const ref = usePlanRef();
  return <Plan key={ref} issueRef={ref} />;
}

function Plan({ issueRef: ref }: { issueRef: string }) {
  const held = useHopper((s) => s.jobs);
  const [draft, setDraft] = useState(ref);
  const [plan, setPlan] = useState<WorkPlan | null>(null);
  const [error, setError] = useState('');
  // Read again (debounced) each time the store's jobs change, as the Jobs tab reads its graph.
  useEffect(() => {
    if (!ref) return;
    let live = true;
    const soon = setTimeout(() => {
      get<WorkPlan>(`/api/planned-work?issue=${encodeURIComponent(ref)}`)
        .then((p) => { if (live && Array.isArray(p.pieces)) { setPlan(p); setError(''); } }, (e: Error) => { if (live) setError(e.message); });
    }, plan ? 150 : 0);
    return () => { live = false; clearTimeout(soon); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again on the store's change only, not on its own answer
  }, [ref, held]);
  const save = (format: 'csv' | 'json') => { download(exportPath(ref, format), `planned-work.${format}`).catch((e: Error) => setError(e.message)); };
  return (
    <Panel title="Planned work" icon={ListTree}
      summary={plan ? <span data-slot="planned-work-status" className={TEXT[STATUS_INFO[plan.status].tone]}>{plan.title}: {STATUS_INFO[plan.status].label.toLowerCase()}</span> : undefined}
      action={<form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) window.location.hash = planHash(draft.trim()); }}>
        <Input data-slot="planned-work-issue" aria-label="Work plan issue" placeholder="owner/name#number or issue URL" value={draft}
          onChange={(e) => setDraft(e.target.value)} className="h-8 w-64" />
        <Button type="submit" size="sm" variant="outline">Open</Button>
        <Button type="button" size="sm" variant="ghost" disabled={!plan} onClick={() => save('csv')} data-slot="planned-work-export-csv"><Download />CSV</Button>
        <Button type="button" size="sm" variant="ghost" disabled={!plan} onClick={() => save('json')} data-slot="planned-work-export-json"><Download />JSON</Button>
      </form>}
      toolbar={plan ? <Counts plan={plan} /> : undefined} bodyClassName="p-0">
      <div data-slot="planned-work" className={cn('space-y-2', plan && 'p-4')}>
        {error && <p data-slot="planned-work-error" className={cn('px-4 pt-3 text-sm', TEXT.bad)}>{error}</p>}
        {!ref ? <Empty>Name an issue to see its work plan: its sub-issues are its plan pieces, and theirs its plan tasks.</Empty>
          : plan ? <><Legend /><PlanGraph plan={plan} /></>
            : !error && <Empty>reading the work plan…</Empty>}
      </div>
    </Panel>
  );
}
