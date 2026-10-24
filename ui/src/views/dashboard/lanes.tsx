// The lane board: every lane on every machine, what it runs, for how long, its job's memory (issue #2722), how far along (when the job says), and its latest activity.
import { ExternalLink, FileCheck, FolderOpen, Hand, Layers, Pause, Play, Telescope, X } from 'lucide-react';
import { useState } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { rejectBody } from '@/components/reject';
import { PriorityLaneMark } from '@/components/priority';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/confirm';
import { GhLink, JobTitle, LinkLostFlag, Since, UnassignedFlag } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { GROUP, canPickUp, laneJobState, laneRows, machineName, overCap, parkRefusal, startsFresh, type LaneRow } from '@/model/board';
import { goalOf, issuePointer } from '@/model/job';
import { laneMemoryText } from '@/model/machine-history';
import { REVIEW_UI, reviewKindOfJob } from '@/model/reviews';
import { personWait, pickUpRefused, type PersonWait } from '@/model/auto-park';
import type { Job, QuestionView, ReviewItemView, ReviewKind } from '@/model/wire';
import { act, useHopper } from '@/store';
import { useJobBoard, useJobIndex } from '@/store/selectors';
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
 * Park a running job or one on a question (issues #501, #530), or on a proposal or a research report (issue #2167): it
 * leaves its lane now, its pane and agent end, and its work tree, session (when it has one), machine, question and review
 * item are kept, in Parked, until it is picked up. The person may say why; the reason is kept on the job, with who parked
 * it. Offered where the daemon takes it; on a running job or one on a question it cannot park, it says why instead.
 */
export function ParkButton({ job }: { job: Job }) {
  const authed = useCanOperate();
  const parking = useHopper((s) => s.health?.parkingExecutors);
  const [reason, setReason] = useState('');
  if (!authed || !parking || (job.status !== 'running' && job.status !== 'waiting_answer')) return null;
  const refused = parkRefusal(job, parking);
  if (refused) return <span data-slot="park-refusal" className="text-xs text-muted-foreground" title={`Park does not apply: ${refused}`}>cannot park: {refused}</span>;
  const kept = job.agentSession === undefined ? 'Its work tree and branch stay on its machine' : 'Its work tree, branch and agent session stay on its machine';
  const item = job.status === 'waiting_answer' && !job.questionId ? reviewKindOfJob(job) : undefined;
  const waitsOn = item ? `, and its ${REVIEW_UI[item].noun} leaves ${REVIEW_UI[item].label}: no reviewer reviews it and no one decides on it` : job.status === 'waiting_answer' ? ', and its question stays open and never expires' : '';
  return (
    <AlertDialog onOpenChange={(open) => { if (!open) setReason(''); }}>
      <AlertDialogTrigger asChild>
        <Button size="xs" variant="outline" aria-label={`Park ${goalOf(job)}`} title="Park: free its lane and its machine, keep its work for later"><Pause />Park</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Park this job?</AlertDialogTitle>
          <AlertDialogDescription>
            “{goalOf(job)}” leaves its lane and its machine now{job.status === 'running' ? ', stopped mid-turn' : ''}. {kept}{waitsOn}, until you pick it up from Parked.{job.agentSession === undefined ? ' No agent session was recorded for it: picked up, it starts a fresh one there.' : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="space-y-1 text-sm">
          <span>Reason <span className="text-muted-foreground">(optional, shown in Parked and the job&apos;s timeline)</span></span>
          <Input data-park-reason value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="why it waits" />
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => act(`/ui/api/jobs/${job.id}/park`, rejectBody(reason), 'Job parked')}>Park job</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** What a parked job waits on a person for (issue #2415), with its open question or its open item. */
export function usePersonWait(job: Job): { wait: PersonWait | undefined; q: QuestionView | undefined; item: ReviewItemView | undefined; kind: ReviewKind | undefined } {
  const kind = reviewKindOfJob(job);
  const q = useHopper((s) => (job.questionId ? s.questions.find((x) => x.id === job.questionId && x.status === 'open') : undefined));
  const item = useHopper((s) => (kind ? s.reviews[kind].items.find((p) => p.jobId === job.id) ?? s.reviews[kind].parked.find((p) => p.jobId === job.id) : undefined));
  return { wait: personWait(q, item && kind ? { kind, stage: item.stage } : undefined), q, item, kind };
}

/** A person wait as people read it: its noun, and what ends it. */
export const personWaitText = (wait: PersonWait): { noun: string; ends: string } =>
  wait === 'question' ? { noun: 'question', ends: 'the answer' } : { noun: REVIEW_UI[wait].noun, ends: 'a decision on it' };

/**
 * Pick up a parked job (issues #501, #565; `POST /ui/api/jobs/:id/requeue`): it returns to its machine and resumes its
 * agent session there. One with no agent session (issue #530) starts a fresh one in its kept work tree, told its
 * question and answer: the person confirms that first, never silently. None for a job auto-park parked on a person
 * (issue #2415): picked up, it would only park again; one a person parked on a person says it parks again.
 */
export function PickUpButton({ job }: { job: Job }) {
  const authed = useCanOperate();
  const { wait } = usePersonWait(job);
  if (!authed || !canPickUp(job) || pickUpRefused(job, wait)) return null;
  const waits = wait && job.pendingAnswer === undefined ? personWaitText(wait) : undefined;
  const again = waits ? ` It waits on its ${waits.noun} again and parks again in a few seconds; ${waits.ends} picks it up.` : '';
  const done = waits ? `Job picked up: it parks again until its ${waits.noun} is answered` : 'Job picked up';
  if (startsFresh(job)) {
    return (
      <Confirm title="Pick up with a fresh session?" action="Pick up and start fresh" onConfirm={() => act(`/ui/api/jobs/${job.id}/requeue`, { freshSession: true }, waits ? done : 'Job picked up: it starts a fresh session')}
        description={<>No agent session was recorded for “{goalOf(job)}”, so it cannot resume where it stopped. It starts a fresh session in its kept work tree, with its branch and work as they are, and is told its task{job.parked?.from === 'waiting_answer' ? ', its question and the answer' : ''} as context. It has none of the earlier session&apos;s history.{again}</>}>
        <Button size="xs" variant="outline" title={`Pick up: back to its machine, in a fresh session.${again}`}><Play />Pick up</Button>
      </Confirm>
    );
  }
  return (
    <Button size="xs" variant="outline" title={`Pick up: back to its machine, resuming its agent session.${again}`}
      onClick={() => act(`/ui/api/jobs/${job.id}/requeue`, {}, done)}><Play />Pick up</Button>
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

/**
 * Ask a job that has not started for a review section's special job (issues #537, #543): its agent writes a proposal,
 * or researches and writes a research report, instead of doing the work.
 */
export function AskButton({ job, kind }: { job: Job; kind: ReviewKind }) {
  const authed = useCanOperate();
  const ui = REVIEW_UI[kind];
  if (!authed || job.spec[kind] || (job.status !== 'queued' && job.status !== 'held')) return null;
  return (
    <Confirm title={`Ask this job for a ${ui.noun}?`} action={`Ask for a ${ui.noun}`} onConfirm={() => act(`/ui/api/jobs/${job.id}/${ui.askPath}`, {}, `The job will write a ${ui.noun}`)}
      description={<>When “{goalOf(job)}” starts, its agent writes a {ui.noun} — {ui.parts} — instead of doing the work. It comes to {ui.label} for a decision.</>}>
      <Button size="xs" variant="outline" aria-label={`Ask ${goalOf(job)} for a ${ui.noun}`} title={`Ask for a ${ui.noun} instead of the work`}>{kind === 'research' ? <Telescope /> : <FileCheck />}{ui.ask}</Button>
    </Confirm>
  );
}

/** What each lane state means, on hover (issue #381). */
const LANE_MEANING = {
  starting: 'Its job is starting: the executor is not running yet.',
  busy: 'Running a job.',
  waiting: 'Its job waits, and still holds this lane.',
  idle: 'Open, with no job: the next waiting job takes it.',
  unopened: 'Room for a lane this machine may open; none is open there now.',
} as const;
const CLOSES_AFTER = 'The job runs to the end; this lane then closes, because the machine has more lanes open than its lane cap allows now (a usage limit or an executor\'s lane cap).';
const ELBOWED_IN = 'A specialty job, or a job that tends a pull request, elbowed in: it started on a lane past this machine\'s lane cap. The lane closes when the job ends, and the machine is back at its cap.';
const PAST_CAP = 'Its job went on in its pane after a question or a wait, and no lane was free: it came back on a lane past this machine\'s lane cap. The lane closes when the job ends, and the machine is back at its cap.';
const OVER_CAP = 'Lanes past the lane cap: a specialty or tend job elbowed in, or a job came back from its pane with no lane free. They close when their jobs end.';

function LaneCard({ row, machine, idle, priority, memory }: { row: LaneRow; machine: string; idle?: string | undefined; priority: boolean; memory?: { text: string; title: string } | null }) {
  const { job, lane } = row;
  const name = lane ? lane.id.slice(lane.id.lastIndexOf('/') + 1) : 'unopened';
  // A draining lane still runs its job (issue #381): it shows busy, and says it closes after the job. A lane with a job
  // says what the job does now: starting, busy or waiting (issue #432).
  const state = job ? laneJobState(job) : row.state === 'draining' ? 'busy' : row.state;
  const pointer = job && issuePointer(job);
  return (
    <div data-lane-job={job?.id} data-lane-state={state} className={cn('rounded-lg border bg-background/40 p-3 transition-colors',
      state !== 'idle' && state !== 'unopened' && 'border-busy/30 bg-busy/[0.04]', state === 'unopened' && 'border-dashed opacity-60')}>
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="min-w-0 truncate font-medium" title={`machine ${machine}`}>{machine}</span>
        <span className="shrink-0 font-mono text-muted-foreground">{name}</span>
        {priority && <PriorityLaneMark />}
        {row.elbowIn && <span data-slot="elbow-in" className="shrink-0 rounded border border-warn/40 px-1 text-warn" title={ELBOWED_IN}>elbow-in · over the cap</span>}
        {row.pastCap && <span data-slot="past-cap" className="shrink-0 rounded border border-warn/40 px-1 text-warn" title={PAST_CAP}>came back · over the cap</span>}
        {row.state === 'draining' && <span className="ml-auto truncate text-muted-foreground" title={row.elbowIn ? ELBOWED_IN : row.pastCap ? PAST_CAP : CLOSES_AFTER}>closes after this job</span>}
        <StatusBadge className={row.state === 'draining' ? undefined : 'ml-auto'} status={state === 'unopened' ? 'not open' : state}
          tone={state === 'unopened' ? 'muted' : undefined} title={LANE_MEANING[state]} />
      </div>
      {pointer && (
        <div data-slot="lane-target" className="mb-1 font-mono text-xs" title={`the issue this lane works on: ${pointer.label}`}>
          <GhLink url={pointer.url}>{pointer.label}<ExternalLink className="size-3 opacity-60" /></GhLink>
        </div>
      )}
      {job ? (
        <div data-job-group={GROUP[job.status]} data-job-id={job.id} data-status={job.status} className="space-y-2">
          <div className="flex items-start gap-2"><JobTitle job={job} className="flex-1" /><ParkButton job={job} /><CancelButton job={job} /></div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {job.startedAt && <span title="Running for">for <Since iso={job.startedAt} /></span>}
            {memory && <span data-slot="lane-memory" className="shrink-0" title={memory.title}>{memory.text}</span>}
            <TaskBar tasks={job.tasks} />
          </div>
          {row.workTree && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground" title={`work tree ${row.workTree}`}>
              <FolderOpen className="size-3.5 shrink-0" />
              <span dir="rtl" className="min-w-0 truncate text-left font-mono"><bdi dir="ltr">{row.workTree}</bdi></span>
            </div>
          )}
          {job.progressMessage && <div className="truncate text-xs text-muted-foreground" title={job.progressMessage}>{job.progressMessage}</div>}
          <LinkLostFlag job={job} />
          <UnassignedFlag job={job} />
        </div>
      ) : lane?.jobId ? (
        <div data-lane-loading className="text-xs text-muted-foreground" title={`job ${lane.jobId}`}>job {lane.jobId.slice(0, 8)} · loading</div>
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
  const rows = laneRows(machines, running, useJobIndex());
  // A machine with no lane to show (its lane count is 0) still says why it runs nothing.
  const laneless = machines.filter((m) => !rows.some((r) => r.machine.id === m.id) && idle.has(m.id));
  // The priority lanes (issue #535): marked where open; the ones not open now named below.
  const view = useHopper((s) => s.priorityLanes);
  const chosen = view?.chosen ?? [];
  const shown = new Set(rows.flatMap((r) => (r.lane ? [r.lane.id] : [])));
  const notOpen = chosen.filter((id) => !shown.has(id));
  return (
    <Panel title="Lanes" icon={Layers} count={`${running.length} running`} list bodyClassName="grid grid-cols-1 gap-2">
      {rows.length ? rows.map((r) => <LaneCard key={r.key} row={r} machine={machineName(r.machine.id, machines)} idle={idle.get(r.machine.id)} priority={!!r.lane && chosen.includes(r.lane.id)}
        memory={r.job ? laneMemoryText(machines.find((m) => m.id === r.machine.id)?.resources, r.job.id) : null} />) : <Empty>no machines</Empty>}
      {notOpen.length > 0 && (
        <a href="#machines" data-slot="priority-lanes-closed" className="text-xs text-muted-foreground hover:text-foreground">
          {notOpen.length === 1 ? 'Priority lane' : 'Priority lanes'} {notOpen.join(', ')} not open now: opened for the next high-priority job
        </a>
      )}
      {overCap(machines).map((o) => (
        <div key={o.machineId} data-slot="over-cap" className="text-xs text-warn" title={OVER_CAP}>
          {machineName(o.machineId, machines)}: {o.inUse}/{o.lanes} lanes in use · {o.inUse - o.lanes} over the cap, back to {o.lanes} when the work over it ends
        </div>
      ))}
      {laneless.map((m) => <div key={m.id} data-lane-idle className="text-xs text-muted-foreground">{machineName(m.id, machines)}: {idle.get(m.id)}</div>)}
    </Panel>
  );
}

/**
 * The job's task count as a bar and `x/y` (issue #794): it steps as each task completes, never on a clock. Before the
 * job has a task list the bar is indeterminate: no count reads as stuck at 0% (issue #381).
 */
function TaskBar({ tasks }: { tasks: Job['tasks'] }) {
  if (!tasks) {
    return (
      <div data-slot="progress" data-indeterminate="true" className="flex flex-1 items-center gap-2" title="No task list yet">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full w-1/3 animate-pulse rounded-full bg-busy/40" /></div>
      </div>
    );
  }
  return (
    <div data-slot="progress" className="flex flex-1 items-center gap-2" title={`${tasks.done} of ${tasks.total} tasks done`}>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
        <div data-slot="progress-fill" className="h-full rounded-full bg-busy transition-[width] duration-700" style={{ width: `${Math.round((tasks.done / tasks.total) * 100)}%` }} />
      </div>
      <span className="num text-right">{tasks.done}/{tasks.total}</span>
    </div>
  );
}
