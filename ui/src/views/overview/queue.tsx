// Waiting (queue order), the jobs on a question, the operator-led jobs, the parked jobs and the locked entries below it, and Ended (the last 24 hours, newest first).
// Each row names its job group, as the cards count them (tested: test/ui/overview-counts.test.ts).
import { AssessmentLine } from '@/components/assessment';
import { Archive, Check, DoorOpen, Hourglass, Lock, RotateCcw, SquareX, X } from 'lucide-react';
import { Confirm } from '@/components/confirm';
import { heldAtGate } from '@/model/blast-radius';
import { goalOf } from '@/model/job';
import { Button } from '@/components/ui/button';
import { CredentialsFlag, JobTitle, Since, UnassignedFlag } from '@/components/job';
import { RejectButton } from '@/components/reject';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { canRerun, machineName, waitingRows } from '@/model/board';
import { ago, between } from '@/model/format';
import { REVIEW_KINDS, REVIEW_UI } from '@/model/reviews';
import { act, rerun, useHopper } from '@/store';
import { useCanAdmin, useCanOperate, useJobBoard } from '@/store/selectors';
import type { Job } from '@/model/wire';
import { AskButton, CancelButton, OperatorLedButton, ParkButton, PickUpButton } from './lanes';

/** Run again: a new job for the item joins the queue now (issue #354). */
function RerunButton({ job }: { job: Job }) {
  return (
    <Button size="xs" variant="outline" title="Run again: a new job for its item joins the queue now"
      onClick={() => void rerun(job.id)}><RotateCcw />Run again</Button>
  );
}

/**
 * Issue #542: a job held at the blast-radius gate runs on a gated machine only once a person lets it through. An admin
 * does, after a confirmation that says what it widens; anyone else sees the hold and no button.
 */
function GatePassButton({ job }: { job: Job }) {
  const admin = useCanAdmin();
  if (!admin || !heldAtGate(job)) return null;
  return (
    <Confirm title="Let this job through the gate?" action="Let it through" onConfirm={() => act(`/ui/api/jobs/${job.id}/gate-pass`, {}, 'Job let through the gate')}
      description={<>“{goalOf(job)}” may then run on a gated machine, with everything that machine can reach: {job.holdReason?.replace(/^held at the blast-radius gate: /, '')}.</>}>
      <Button size="xs" variant="outline" data-slot="gate-pass" title="Let through the blast-radius gate: it may run on a gated machine"><DoorOpen />Let through</Button>
    </Confirm>
  );
}

/**
 * Issue #371: the job ended, but its cleanup could not reach its machine, so its pane and agent may still
 * run there. The hopper tries again on every tick; Mark closed is for a pane closed by hand, or a machine gone for good.
 */
function CleanupDeferredFlag({ job, className }: { job: Job; className?: string }) {
  const operate = useCanOperate();
  const d = job.cleanupDeferred;
  if (!d) return null;
  return (
    <div data-cleanup-deferred className={`flex items-start gap-1.5 text-xs text-warn ${className ?? ''}`} title={`since ${d.at}: ${d.error}`}>
      <span className="min-w-0 flex-1">Its pane may still be open: the hopper could not reach its machine to close it, and tries again until it can. A new job for its item waits until then.</span>
      {operate && <Button size="xs" variant="ghost" title="Mark closed: you closed its pane by hand, or its machine is gone for good. The hopper stops trying."
        onClick={() => act(`/ui/api/jobs/${job.id}/cleaned-up`, {}, 'Marked closed')}><SquareX />Mark closed</Button>}
    </div>
  );
}

/**
 * The locked entries (issue #355): failed jobs kept in the queue, never run by themselves, until run again
 * or dismissed. Under the Overview's Waiting jobs, and in the Queue view's own panel (`heading` false).
 */
export function LockedRows({ heading = true }: { heading?: boolean }) {
  const locked = useHopper((s) => s.locked);
  const operate = useCanOperate();
  const now = useNow();
  if (locked.length === 0) return null;
  return <>
    {heading && <div className="flex items-center gap-2 bg-muted/30 px-4 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
      Locked<span className="num font-normal text-muted-foreground/70">{locked.length}</span>
    </div>}
    {locked.map((job) => (
      <div key={job.id} data-job-group="locked" data-job-id={job.id} data-status={job.status} className="space-y-1.5 px-4 py-3">
        <div className="flex items-start gap-2">
          <Lock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <JobTitle job={job} className="flex-1" />
          {operate && <>
            {canRerun(job, [job]) && <RerunButton job={job} />}
            <Button size="xs" variant="ghost" title="Dismiss: it leaves the queue and stays failed"
              onClick={() => act(`/ui/api/jobs/${job.id}/dismiss`, {}, 'Dismissed')}><X />Dismiss</Button>
          </>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pl-5.5 text-xs text-muted-foreground">
          <StatusBadge status="failed" label="locked" title="Failed, and kept in the queue: it never starts by itself. Run it again or dismiss it." />
          <span className="num">prio {job.priority}</span>
          {job.rerunOf && <span title={job.rerunOf}>runs {job.rerunOf.slice(0, 8)} again</span>}
          <span className="ml-auto" title={job.finishedAt}>failed {ago(job.finishedAt ?? job.updatedAt, now)}</span>
        </div>
        {job.error && <div className="line-clamp-2 pl-5.5 text-xs text-bad/90" title={job.error}>{job.error}</div>}
        <AssessmentLine job={job} className="pl-5.5" />
        <CleanupDeferredFlag job={job} className="pl-5.5" />
      </div>
    ))}
  </>;
}

/** What each waiting state means, on hover (issue #381). */
const WAITING_MEANING: Record<string, string> = {
  queued: 'Admitted: it starts as soon as a lane is free.',
  wait: 'Admitted, and every lane it may use is in use: it starts when one frees. The line below names the lane cap that binds.',
  held: 'Kept out by a rule or a person — the router, the queue gate, or no machine able to run it. The line below says why.',
  approved: 'A person approved it: no router hold applies.',
};

/**
 * The parked jobs (issue #501): out of their lanes, no pane or agent, their work tree and agent session kept on their
 * machine until picked up. Under the Overview's Waiting jobs, and in the Queue view's own panel (`heading` false). One
 * auto-park parked (issue #650) says why.
 */
export function ParkedRows({ heading = true }: { heading?: boolean }) {
  const { parked } = useJobBoard();
  const machines = useHopper((s) => s.machines);
  if (parked.length === 0) return null;
  return <>
    {heading && <div className="flex items-center gap-2 bg-muted/30 px-4 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
      Parked<span className="num font-normal text-muted-foreground/70">{parked.length}</span>
    </div>}
    {parked.map((job) => (
      <div key={job.id} data-job-group="parked" data-job-id={job.id} data-status={job.status} className="space-y-1.5 px-4 py-3">
        <div className="flex items-start gap-2"><JobTitle job={job} className="flex-1" /><PickUpButton job={job} /><CancelButton job={job} /></div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <StatusBadge status="parked" title="Out of its lane, its pane and agent ended: its work tree, branch and agent session are kept on its machine until it is picked up." />
          {job.resumeOn && <span>on {machineName(job.resumeOn, machines)}</span>}
          {job.pendingAnswer !== undefined && job.parked?.from === 'waiting_answer' && <span>answered, resumes with it</span>}
          {job.pendingAnswer === undefined && job.parked?.from === 'waiting_answer' && <a href="#parked" className="text-question hover:underline">question open →</a>}
          <span className="ml-auto">for <Since iso={job.parked?.at ?? job.updatedAt} /></span>
        </div>
        {job.parked?.why && <div data-slot="parked-why" className="text-xs text-muted-foreground">{job.parked.why}</div>}
        {job.workTree && <div className="truncate font-mono text-xs text-muted-foreground" title={`work tree ${job.workTree}`}>{job.workTree}</div>}
      </div>
    ))}
  </>;
}

export function WaitingPanel() {
  const board = useJobBoard();
  const latest = useHopper((s) => s.decisions[0]);
  const authed = useCanOperate();
  const rows = waitingRows(board, latest);
  return (
    <Panel title="Waiting" icon={Hourglass} count={rows.length || ''} list bodyClassName="divide-y p-0">
      {rows.length ? rows.map(({ job, position, effectivePriority }) => (
        <div key={job.id} data-job-group="waiting" data-job-id={job.id} data-status={job.status} className="space-y-1.5 px-4 py-3">
          <div className="flex items-start gap-2">
            <span className="num mt-0.5 w-5 shrink-0 text-xs text-muted-foreground">{position}</span>
            <JobTitle job={job} className="flex-1" />
            {job.accepted === false && <a href="#queue" className="text-xs text-warn hover:underline">accept in Queue →</a>}
            <GatePassButton job={job} />
            {authed && job.status === 'held' && !job.approved && job.accepted !== false && !heldAtGate(job) && (
              <Button size="xs" variant="outline" onClick={() => act(`/ui/api/jobs/${job.id}/approve`, {}, 'Job approved')}><Check />Approve</Button>
            )}
            {authed && <RejectButton job={job} />}
            {REVIEW_KINDS.map((k) => <AskButton key={k} job={job} kind={k} />)}
            <OperatorLedButton job={job} />
            <CancelButton job={job} />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pl-7 text-xs text-muted-foreground">
            {job.status === 'queued' && job.waitReason
              ? <StatusBadge status="queued" label="waiting for a lane" title={WAITING_MEANING.wait} />
              : <StatusBadge status={job.status} title={WAITING_MEANING[job.status]} />}
            <span className="num">prio {job.priority}{effectivePriority != null && effectivePriority !== job.priority && ` → ${effectivePriority}`}</span>
            {job.approved && <StatusBadge status="approved" tone="ok" title={WAITING_MEANING.approved} />}
            {REVIEW_KINDS.filter((k) => job.spec[k]).map((k) => <StatusBadge key={k} status={k} tone="question" label={`${REVIEW_UI[k].noun} asked`} title={`Its agent writes a ${REVIEW_UI[k].noun} instead of doing the work`} />)}
            {job.advice && <span title={job.advice.reason}>advice <b className="font-medium text-foreground/80">{job.advice.action}</b></span>}
            <span className="ml-auto">for <Since iso={job.createdAt} /></span>
          </div>
          {job.holdReason && <div className="truncate pl-7 text-xs text-warn/90" title={job.holdReason}>{job.holdReason}</div>}
          {job.status === 'queued' && job.waitReason && <div className="truncate pl-7 text-xs text-muted-foreground" title={job.waitReason}>{job.waitReason.replace(/^waiting for a lane: /, '')}</div>}
        </div>
      )) : <Empty>nothing waiting</Empty>}
      {board.waitingAnswer.length > 0 && <>
        <div className="flex items-center gap-2 bg-muted/30 px-4 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          On a question<span className="num font-normal text-muted-foreground/70">{board.waitingAnswer.length}</span>
        </div>
        {board.waitingAnswer.map((job) => (
          <div key={job.id} data-job-group="waitingAnswer" data-job-id={job.id} data-status={job.status} className="space-y-1.5 px-4 py-3">
            <div className="flex items-start gap-2"><JobTitle job={job} className="flex-1" /><ParkButton job={job} /><CancelButton job={job} /></div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <a href="#questions"><StatusBadge status="waiting_answer" label="on a question →" title="Paused on a question: its lane is free until the question is answered." /></a>
              <span className="ml-auto">for <Since iso={job.updatedAt} /></span>
            </div>
            <UnassignedFlag job={job} />
            <CredentialsFlag job={job} />
          </div>
        ))}
      </>}
      {board.operatorLed.length > 0 && <>
        <div className="flex items-center gap-2 bg-muted/30 px-4 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Operator-led<span className="num font-normal text-muted-foreground/70">{board.operatorLed.length}</span>
        </div>
        {board.operatorLed.map((job) => (
          <div key={job.id} data-job-group="operatorLed" data-job-id={job.id} data-status={job.status} className="space-y-1.5 px-4 py-3">
            <div className="flex items-start gap-2"><JobTitle job={job} className="flex-1" /><CancelButton job={job} /></div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <StatusBadge status="operator_led" label="operator-led" title="Worked by hand: the hopper runs nothing for it." />
              <span>worked by hand, done at its pull request</span>
              <span className="ml-auto">for <Since iso={job.startedAt ?? job.updatedAt} /></span>
            </div>
            <UnassignedFlag job={job} />
            <CredentialsFlag job={job} />
          </div>
        ))}
      </>}
      <ParkedRows />
      <LockedRows />
    </Panel>
  );
}

export function EndedPanel() {
  const { ended } = useJobBoard();
  const jobs = useHopper((s) => s.jobs);
  const operate = useCanOperate();
  const now = useNow();
  return (
    <Panel title="Ended" icon={Archive} count={ended.length ? `${ended.length} in 24 h` : ''} list bodyClassName="divide-y p-0">
      {ended.length ? ended.map((job) => (
        <div key={job.id} data-job-group="ended" data-job-id={job.id} data-status={job.status} className="space-y-1.5 px-4 py-3">
          <div className="flex items-start gap-2">
            <JobTitle job={job} className="flex-1" />
            {operate && canRerun(job, Object.values(jobs)) && <RerunButton job={job} />}
            <StatusBadge status={job.status} />
          </div>
          <div className="num flex gap-3 text-xs text-muted-foreground">
            <span title={job.finishedAt}>{ago(job.finishedAt ?? job.updatedAt, now)}</span>
            {job.startedAt && <span>took {between(job.startedAt, job.finishedAt)}</span>}
          </div>
          {job.error && <div className="line-clamp-2 text-xs text-bad/90" title={job.error}>{job.error}</div>}
          <AssessmentLine job={job} />
          <CleanupDeferredFlag job={job} />
        </div>
      )) : <Empty>nothing ended in 24 h</Empty>}
    </Panel>
  );
}
