// The lane board: every lane on every machine, what it runs, for how long, how far along (when the job says), and its latest activity.
import { FolderOpen, Hand, Layers, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/confirm';
import { JobTitle, Since } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { laneRows, machineName, type LaneRow } from '@/model/board';
import { goalOf } from '@/model/job';
import type { Job } from '@/model/wire';
import { act, useHopper } from '@/store';
import { useJobBoard } from '@/store/selectors';
import { cn } from '@/lib/utils';
import { useCanOperate } from '@/store/selectors';

export function CancelButton({ job }: { job: Job }) {
  const authed = useCanOperate();
  if (!authed) return null;
  return (
    <Confirm title="Cancel this job?" action="Cancel job" onConfirm={() => act(`/ui/api/jobs/${job.id}/cancel`, {}, 'Job cancelled')}
      description={<>“{goalOf(job)}” stops now and its source is told it was cancelled.</>}>
      <Button variant="ghost" size="icon-xs" aria-label="Cancel job" className="text-muted-foreground hover:text-bad"><X /></Button>
    </Confirm>
  );
}

/** Claim a waiting job as operator-led (issue #318): its work is done by hand, and the hopper runs nothing for it. */
export function OperatorLedButton({ job }: { job: Job }) {
  const authed = useCanOperate();
  if (!authed) return null;
  return (
    <Confirm title="Claim this job as operator-led?" action="Claim as operator-led" onConfirm={() => act(`/ui/api/jobs/${job.id}/operator-led`, {}, 'Job claimed as operator-led')}
      description={<>“{goalOf(job)}” is worked by hand — in an IDE or a terminal. The hopper runs nothing for it and shows it as operator-led until its pull request closing the issue is done.</>}>
      <Button size="xs" variant="outline" aria-label={`Claim ${goalOf(job)} as operator-led`} title="Claim as operator-led: work it by hand"><Hand />Operator-led</Button>
    </Confirm>
  );
}

/** What each lane state means, on hover (issue #381). */
const LANE_MEANING = {
  busy: 'Running a job.',
  idle: 'Open, with no job: the next waiting job takes it.',
  unopened: 'Room for a lane this machine may open; none is open there now.',
} as const;
const CLOSES_AFTER = 'The job runs to the end; this lane then closes, because the machine has more lanes open than its lane cap allows now (a usage limit or an executor\'s lane cap).';

function LaneCard({ row, machine }: { row: LaneRow; machine: string }) {
  const { job, lane } = row;
  const name = lane ? lane.id.slice(lane.id.lastIndexOf('/') + 1) : 'unopened';
  // A draining lane still runs its job (issue #381): it shows busy, and says it closes after the job.
  const state = row.state === 'draining' ? 'busy' : row.state;
  return (
    <div data-lane-job={job?.id} className={cn('rounded-lg border bg-background/40 p-3 transition-colors',
      state === 'busy' && 'border-busy/30 bg-busy/[0.04]', state === 'unopened' && 'border-dashed opacity-60')}>
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="min-w-0 truncate font-medium" title={`machine ${machine}`}>{machine}</span>
        <span className="shrink-0 font-mono text-muted-foreground">{name}</span>
        {row.state === 'draining' && <span className="ml-auto truncate text-muted-foreground" title={CLOSES_AFTER}>closes after this job</span>}
        <StatusBadge className={row.state === 'draining' ? undefined : 'ml-auto'} status={state === 'unopened' ? 'not open' : state}
          tone={state === 'unopened' ? 'muted' : undefined} title={LANE_MEANING[state]} />
      </div>
      {job ? (
        <div data-job-group="running" data-job-id={job.id} data-status={job.status} className="space-y-2">
          <div className="flex items-start gap-2"><JobTitle job={job} className="flex-1" /><CancelButton job={job} /></div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {job.startedAt && <span title="Running for">for <Since iso={job.startedAt} /></span>}
            {/* A bar only for a percentage the job reported (issue #381): none reads as stuck at 0%. */}
            {job.progress !== undefined && (
              <div data-slot="progress" className="flex flex-1 items-center gap-2">
                <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-busy transition-[width] duration-700" style={{ width: `${Math.round(job.progress * 100)}%` }} />
                </div>
                <span className="num w-8 text-right">{Math.round(job.progress * 100)}%</span>
              </div>
            )}
          </div>
          {row.workTree && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground" title={`work tree ${row.workTree}`}>
              <FolderOpen className="size-3.5 shrink-0" />
              <span dir="rtl" className="min-w-0 truncate text-left font-mono"><bdi dir="ltr">{row.workTree}</bdi></span>
            </div>
          )}
          {job.progressMessage && <div className="truncate text-xs text-muted-foreground" title={job.progressMessage}>{job.progressMessage}</div>}
        </div>
      ) : <div className="text-xs text-muted-foreground/70">{lane ? 'idle' : 'capacity, no lane open'}</div>}
    </div>
  );
}

export function LanesPanel() {
  const machines = useHopper((s) => s.machines);
  const { running } = useJobBoard();
  const rows = laneRows(machines, running);
  return (
    <Panel title="Lanes" icon={Layers} count={`${running.length} running`} list bodyClassName="grid grid-cols-1 gap-2">
      {rows.length ? rows.map((r) => <LaneCard key={r.key} row={r} machine={machineName(r.machine.id, machines)} />) : <Empty>no machines</Empty>}
    </Panel>
  );
}
