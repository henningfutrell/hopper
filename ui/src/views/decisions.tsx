// Decisions, newest first, as a table (issue #2375): time, the job it is about (its issue and title), its kind, and the
// outcome as a sentence; the detail — the raw ids, starts, holds, lane plans, divergences and reasons — opens below the row.
// Below them, the decider's picks (issue #897): their one home, with Override.
import { JsonBlock } from '@/components/json-block';
import { ChevronRight, Scale } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Empty, Panel } from '@/components/panel';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatusBadge } from '@/components/status';
import { startTarget, machineName } from '@/model/board';
import { decisionJobs, decisionKind, decisionOutcome } from '@/model/decisions';
import { clock } from '@/model/format';
import type { Decision } from '@/model/wire';
import { useHopper } from '@/store';
import { useJobName } from '@/store/selectors';
import { DeciderPicks } from '@/views/minor-decisions';

function Section({ title, children }: { title: string; children: React.ReactNode[] }) {
  if (!children.length) return null;
  return <div className="space-y-1"><div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</div>{children}</div>;
}

/** One Decision as a table row: time, the job it is about, its kind and its outcome as a sentence; the raw detail opens below. */
function DecisionRow({ d }: { d: Decision }) {
  const nameOf = useJobName();
  const machines = useHopper((s) => s.machines);
  const [open, setOpen] = useState(false);
  const jobs = decisionJobs(d);
  const row = 'text-xs leading-relaxed';
  return (
    <>
      <TableRow data-slot="decision-row" className="text-xs">
        <TableCell className="num w-20 text-muted-foreground" title={d.at}>{clock(d.at)}</TableCell>
        <TableCell data-slot="decision-job" className="max-w-80 truncate whitespace-normal">
          {jobs.length ? <>{nameOf(jobs[0]!)}{jobs.length > 1 && <span className="text-muted-foreground"> +{jobs.length - 1} more</span>}</> : <span className="text-muted-foreground">no job</span>}
        </TableCell>
        <TableCell data-slot="decision-kind" className="text-muted-foreground">{decisionKind(d)}</TableCell>
        <TableCell className="whitespace-normal">
          <span data-slot="decision-outcome">{decisionOutcome(d)}</span>
          {d.advice.length > 0 && <StatusBadge status="divergence" tone="warn" label={`${d.advice.length} divergence`} className="ml-2" />}
        </TableCell>
        <TableCell className="w-8 text-right">
          <Button data-slot="decision-detail-toggle" size="icon-xs" variant="ghost" aria-expanded={open} aria-label={open ? 'Hide the detail' : 'Show the detail'} onClick={() => setOpen(!open)}>
            <ChevronRight className={open ? 'rotate-90 transition-transform' : 'transition-transform'} />
          </Button>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} data-slot="decision-detail" className="space-y-3 whitespace-normal px-4 pb-4 pl-10">
            <div className="font-mono text-[11px] text-muted-foreground">decision {d.id} · {d.trigger}</div>
            <Section title="Starts">{d.start.map((s) => <div key={s.jobId} className={row}><b className="font-medium">{nameOf(s.jobId)}</b> <span className="font-mono text-muted-foreground">{s.jobId}</span> → {startTarget(s, machines)} · eff {s.effectivePriority} — <span className="text-muted-foreground">{s.reason}</span></div>)}</Section>
            <Section title="Holds">{d.hold.map((h) => <div key={h.jobId} className={row}><b className="font-medium">{nameOf(h.jobId)}</b> <span className="font-mono text-muted-foreground">{h.jobId}</span> — <span className="text-muted-foreground">{h.reason}</span></div>)}</Section>
            <Section title="Lane plans">{d.lanes.map((p) => <div key={p.machineId} className={row}><span className="font-medium">{machineName(p.machineId, machines)}</span> {p.current} → {p.target}, open {p.open}, close {p.close.length}, drain {p.drain.length} — <span className="text-muted-foreground">{p.reason}</span></div>)}</Section>
            <Section title="Divergences">{d.advice.map((v) => <div key={v.jobId} className={`${row} text-warn`}>{nameOf(v.jobId)}: {v.advice} — native {v.native}, with advice {v.withAdvice} — {v.note}</div>)}</Section>
            <Section title="Reasons">{d.reasons.map((r, i) => <div key={i} className={`${row} text-muted-foreground`}>· {r}</div>)}</Section>
            <Collapsible>
              <CollapsibleTrigger className="text-xs text-muted-foreground hover:text-foreground">raw inputs</CollapsibleTrigger>
              <CollapsibleContent className="mt-2"><JsonBlock value={d.inputs} label="raw inputs" className="max-h-96" /></CollapsibleContent>
            </Collapsible>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function Decisions() {
  const decisions = useHopper((s) => s.decisions);
  return (
    <div className="space-y-3">
      <Panel title="Decisions" icon={Scale} count={decisions.length || ''} bodyClassName="p-0">
        {decisions.length ? (
          <Table data-slot="decisions-table">
            <TableHeader><TableRow className="text-xs"><TableHead>Time</TableHead><TableHead>Job</TableHead><TableHead>Kind</TableHead><TableHead>Outcome</TableHead><TableHead><span className="sr-only">Detail</span></TableHead></TableRow></TableHeader>
            <TableBody>{decisions.map((d) => <DecisionRow key={d.id} d={d} />)}</TableBody>
          </Table>
        ) : <Empty>no decisions yet</Empty>}
      </Panel>
      <DeciderPicks />
    </div>
  );
}
