// The lane board: every lane on every machine, what it runs, for how long, how far along.
import { Layers, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/confirm';
import { JobTitle, Since } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { laneRows, type LaneRow } from '@/model/board';
import { goalOf } from '@/model/job';
import type { Job } from '@/model/wire';
import { act, useHopper } from '@/store';
import { cn } from '@/lib/utils';

export function CancelButton({ job }: { job: Job }) {
  const authed = useHopper((s) => s.authed);
  if (!authed) return null;
  return (
    <Confirm title="Cancel this job?" action="Cancel job" onConfirm={() => act(`/ui/api/jobs/${job.id}/cancel`, {}, 'Job cancelled')}
      description={<>“{goalOf(job)}” stops now and its source is told it was cancelled.</>}>
      <Button variant="ghost" size="icon-xs" aria-label="Cancel job" className="text-muted-foreground hover:text-bad"><X /></Button>
    </Confirm>
  );
}

function LaneCard({ row }: { row: LaneRow }) {
  const { job, lane } = row;
  const name = lane ? lane.id.split('/').pop() : 'unopened';
  return (
    <div className={cn('rounded-lg border bg-background/40 p-3 transition-colors',
      row.state === 'busy' && 'border-busy/30 bg-busy/[0.04]', row.state === 'draining' && 'border-warn/30', row.state === 'unopened' && 'border-dashed opacity-60')}>
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="font-mono font-medium">{name}</span>
        <span className="truncate text-muted-foreground">{row.machine.label}</span>
        <StatusBadge className="ml-auto" status={row.state === 'unopened' ? 'not open' : row.state} tone={row.state === 'unopened' ? 'muted' : undefined} />
      </div>
      {job ? (
        <div className="space-y-2">
          <div className="flex items-start gap-2"><JobTitle job={job} className="flex-1" /><CancelButton job={job} /></div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {job.startedAt && <Since iso={job.startedAt} className="w-14 shrink-0" />}
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-busy transition-[width] duration-700" style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }} />
            </div>
            <span className="num w-8 text-right">{Math.round((job.progress ?? 0) * 100)}%</span>
          </div>
          {job.progressMessage && <div className="truncate text-xs text-muted-foreground" title={job.progressMessage}>{job.progressMessage}</div>}
        </div>
      ) : <div className="text-xs text-muted-foreground/70">{lane ? 'idle' : 'capacity, no lane open'}</div>}
    </div>
  );
}

export function LanesPanel() {
  const machines = useHopper((s) => s.machines);
  const running = useHopper((s) => s.queue.running);
  const rows = laneRows(machines, running);
  return (
    <Panel title="Lanes" icon={Layers} count={`${running.length} running`} bodyClassName="grid gap-2">
      {rows.length ? rows.map((r) => <LaneCard key={r.key} row={r} />) : <Empty>no machines</Empty>}
    </Panel>
  );
}
