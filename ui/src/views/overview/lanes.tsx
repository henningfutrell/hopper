// The lane board: every lane on every machine, what it runs, for how long, how far along (when the job says), and its latest activity.
import { FileCheck, FolderOpen, Hand, Layers, Pause, Play, X } from 'lucide-react';
import { PriorityLaneMark } from '@/components/priority';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/confirm';
import { JobTitle, Since, UnassignedFlag } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { canRequeue, laneRows, machineName, parkRefusal, startsFresh, type LaneRow } from '@/model/board';
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

/**
 * Park a running job or one on a question (issues #501, #530): it leaves its lane now, its pane and agent end, and its
 * work tree, session (when it has one), machine and question are kept until it is re-queued. Offered where the daemon
 * takes it; on a running job or one on a question it cannot park, it says why instead.
 */
export function ParkButton({ job }: { job: Job }) {
  const authed = useCanOperate();
  const parking = useHopper((s) => s.health?.parkingExecutors);
  if (!authed || !parking || (job.status !== 'running' && job.status !== 'waiting_answer')) return null;
  const refused = parkRefusal(job, parking);
  if (refused) return <span data-slot="park-refusal" className="text-xs text-muted-foreground" title={`Park does not apply: ${refused}`}>cannot park: {refused}</span>;
  const kept = job.agentSession === undefined ? 'Its work tree and branch stay on its machine' : 'Its work tree, branch and agent session stay on its machine';
  return (
    <Confirm title="Park this job?" action="Park job" onConfirm={() => act(`/ui/api/jobs/${job.id}/park`, {}, 'Job parked')}
      description={<>“{goalOf(job)}” leaves its lane and its machine now{job.status === 'running' ? ', stopped mid-turn' : ''}. {kept}{job.status === 'waiting_answer' ? ', and its question stays open and never expires' : ''}, until you re-queue it.{job.agentSession === undefined ? ' No agent session was recorded for it: re-queued, it starts a fresh one there.' : ''}</>}>
      <Button size="xs" variant="outline" aria-label={`Park ${goalOf(job)}`} title="Park: free its lane and its machine, keep its work for later"><Pause />Park</Button>
    </Confirm>
  );
}

/**
 * Re-queue a parked job (issue #501): it returns to its machine and resumes its agent session there. One with no agent
 * session (issue #530) starts a fresh one in its kept work tree, told its question and answer: the person confirms
 * that first, never silently.
 */
export function RequeueButton({ job }: { job: Job }) {
  const authed = useCanOperate();
  if (!authed || !canRequeue(job)) return null;
  if (startsFresh(job)) {
    return (
      <Confirm title="Re-queue with a fresh session?" action="Re-queue and start fresh" onConfirm={() => act(`/ui/api/jobs/${job.id}/requeue`, { freshSession: true }, 'Job re-queued: it starts a fresh session')}
        description={<>No agent session was recorded for “{goalOf(job)}”, so it cannot resume where it stopped. It starts a fresh session in its kept work tree, with its branch and work as they are, and is told its task{job.parked?.from === 'waiting_answer' ? ', its question and the answer' : ''} as context. It has none of the earlier session&apos;s history.</>}>
        <Button size="xs" variant="outline" title="Re-queue: back to its machine, in a fresh session"><Play />Re-queue</Button>
      </Confirm>
    );
  }
  return (
    <Button size="xs" variant="outline" title="Re-queue: back to its machine, resuming its agent session"
      onClick={() => act(`/ui/api/jobs/${job.id}/requeue`, {}, 'Job re-queued')}><Play />Re-queue</Button>
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

/** Ask a job that has not started for a proposal (issue #537): its agent writes one instead of doing the work. */
export function ProposeButton({ job }: { job: Job }) {
  const authed = useCanOperate();
  if (!authed || job.spec.proposal || (job.status !== 'queued' && job.status !== 'held')) return null;
  return (
    <Confirm title="Ask this job for a proposal?" action="Ask for a proposal" onConfirm={() => act(`/ui/api/jobs/${job.id}/propose`, {}, 'The job will write a proposal')}
      description={<>When “{goalOf(job)}” starts, its agent writes a proposal — goal, approach, alternatives, risks, effort, the context it relied on — instead of doing the work. It is reviewed and comes to Proposals for a decision.</>}>
      <Button size="xs" variant="outline" aria-label={`Ask ${goalOf(job)} for a proposal`} title="Ask for a proposal instead of the work"><FileCheck />Propose</Button>
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

function LaneCard({ row, machine, idle, priority }: { row: LaneRow; machine: string; idle?: string | undefined; priority: boolean }) {
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
        {priority && <PriorityLaneMark />}
        {row.state === 'draining' && <span className="ml-auto truncate text-muted-foreground" title={CLOSES_AFTER}>closes after this job</span>}
        <StatusBadge className={row.state === 'draining' ? undefined : 'ml-auto'} status={state === 'unopened' ? 'not open' : state}
          tone={state === 'unopened' ? 'muted' : undefined} title={LANE_MEANING[state]} />
      </div>
      {job ? (
        <div data-job-group="running" data-job-id={job.id} data-status={job.status} className="space-y-2">
          <div className="flex items-start gap-2"><JobTitle job={job} className="flex-1" /><ParkButton job={job} /><CancelButton job={job} /></div>
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
          <UnassignedFlag job={job} />
        </div>
      ) : (
        <div data-lane-idle className="text-xs text-muted-foreground/70" title={idle}>
          {lane ? 'idle' : 'capacity, no lane open'}{idle && <> · <span className="text-muted-foreground">{idle}</span></>}
        </div>
      )}
    </div>
  );
}

/** Why each machine leaves lanes unused, from the latest Decision (issue #440). */
function useIdleReasons(): Map<string, string> {
  const latest = useHopper((s) => s.decisions[0]);
  return new Map((latest?.lanes ?? []).flatMap((l) => (l.idle ? [[l.machineId, l.idle] as const] : [])));
}

export function LanesPanel() {
  const machines = useHopper((s) => s.machines);
  const { running } = useJobBoard();
  const idle = useIdleReasons();
  const rows = laneRows(machines, running);
  // A machine with no lane to show (its lane count is 0) still says why it runs nothing.
  const laneless = machines.filter((m) => !rows.some((r) => r.machine.id === m.id) && idle.has(m.id));
  // The priority lanes (issue #535): marked where open; the ones not open now named below.
  const view = useHopper((s) => s.priorityLanes);
  const chosen = view?.chosen ?? [];
  const shown = new Set(rows.flatMap((r) => (r.lane ? [r.lane.id] : [])));
  const notOpen = chosen.filter((id) => !shown.has(id));
  return (
    <Panel title="Lanes" icon={Layers} count={`${running.length} running`} list bodyClassName="grid grid-cols-1 gap-2">
      {rows.length ? rows.map((r) => <LaneCard key={r.key} row={r} machine={machineName(r.machine.id, machines)} idle={idle.get(r.machine.id)} priority={!!r.lane && chosen.includes(r.lane.id)} />) : <Empty>no machines</Empty>}
      {notOpen.length > 0 && (
        <a href="#machines" data-slot="priority-lanes-closed" className="text-xs text-muted-foreground hover:text-foreground">
          {notOpen.length === 1 ? 'Priority lane' : 'Priority lanes'} {notOpen.join(', ')} not open now: opened for the next high-priority job
        </a>
      )}
      {laneless.map((m) => <div key={m.id} data-lane-idle className="text-xs text-muted-foreground">{machineName(m.id, machines)}: {idle.get(m.id)}</div>)}
    </Panel>
  );
}
