// Decisions, newest first: each one's starts, holds, lane plans, divergences and reasons.
import { ChevronRight, Scale } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { startTarget, machineName } from '@/model/board';
import { clock } from '@/model/format';
import type { Decision } from '@/model/wire';
import { useHopper } from '@/store';
import { useJobName } from '@/store/selectors';

function Section({ title, children }: { title: string; children: React.ReactNode[] }) {
  if (!children.length) return null;
  return <div className="space-y-1"><div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</div>{children}</div>;
}

function DecisionRow({ d }: { d: Decision }) {
  const nameOf = useJobName();
  const machines = useHopper((s) => s.machines);
  const row = 'text-xs leading-relaxed';
  return (
    <Collapsible className="border-b last:border-0">
      <CollapsibleTrigger className="group flex w-full flex-wrap items-center gap-2 px-4 py-2.5 text-left text-xs hover:bg-muted/40">
        <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="num font-mono text-muted-foreground">{clock(d.at)}</span>
        <StatusBadge status={d.trigger} />
        <StatusBadge status={d.routerMode} tone={d.routerMode === 'active' ? 'warn' : 'muted'} />
        <span className="num">{d.start.length} start · {d.hold.length} hold</span>
        {d.advice.length > 0 && <StatusBadge status="divergence" tone="warn" label={`${d.advice.length} divergence`} />}
        <span className="ml-auto hidden truncate font-mono text-muted-foreground/60 sm:block">{d.id.slice(0, 8)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 px-4 pb-4 pl-10">
        <Section title="Starts">{d.start.map((s) => <div key={s.jobId} className={row}><b className="font-medium">{nameOf(s.jobId)}</b> → {startTarget(s, machines)} · eff {s.effectivePriority} — <span className="text-muted-foreground">{s.reason}</span></div>)}</Section>
        <Section title="Holds">{d.hold.map((h) => <div key={h.jobId} className={row}><b className="font-medium">{nameOf(h.jobId)}</b> — <span className="text-muted-foreground">{h.reason}</span></div>)}</Section>
        <Section title="Lane plans">{d.lanes.map((p) => <div key={p.machineId} className={row}><span className="font-medium">{machineName(p.machineId, machines)}</span> {p.current} → {p.target}, open {p.open}, close {p.close.length}, drain {p.drain.length} — <span className="text-muted-foreground">{p.reason}</span></div>)}</Section>
        <Section title="Divergences">{d.advice.map((v) => <div key={v.jobId} className={`${row} text-warn`}>{nameOf(v.jobId)}: {v.advice} — native {v.native}, with advice {v.withAdvice} — {v.note}</div>)}</Section>
        <Section title="Reasons">{d.reasons.map((r, i) => <div key={i} className={`${row} text-muted-foreground`}>· {r}</div>)}</Section>
        <Collapsible>
          <CollapsibleTrigger className="text-xs text-muted-foreground hover:text-foreground">raw inputs</CollapsibleTrigger>
          <CollapsibleContent><pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[11px]">{JSON.stringify(d.inputs, null, 2)}</pre></CollapsibleContent>
        </Collapsible>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function Decisions() {
  const decisions = useHopper((s) => s.decisions);
  return (
    <Panel title="Decisions" icon={Scale} count={decisions.length || ''} bodyClassName="p-0">
      {decisions.length ? decisions.map((d) => <DecisionRow key={d.id} d={d} />) : <Empty>no decisions yet</Empty>}
    </Panel>
  );
}
