// Waiting (queue order), the jobs on a question below it, and Ended (the last 24 hours, newest first).
// Each row names its job group, as the cards count them (tested: test/ui/overview-counts.test.ts).
import { Archive, Check, Hourglass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { JobTitle, Since } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { waitingRows } from '@/model/board';
import { ago, between } from '@/model/format';
import { act, useHopper } from '@/store';
import { useJobBoard } from '@/store/selectors';
import { CancelButton } from './lanes';

export function WaitingPanel() {
  const board = useJobBoard();
  const latest = useHopper((s) => s.decisions[0]);
  const authed = useHopper((s) => s.authed);
  const rows = waitingRows(board, latest);
  return (
    <Panel title="Waiting" icon={Hourglass} count={rows.length || ''} bodyClassName="divide-y p-0">
      {rows.length ? rows.map(({ job, position, effectivePriority }) => (
        <div key={job.id} data-job-group="waiting" data-job-id={job.id} data-status={job.status} className="space-y-1.5 px-4 py-3">
          <div className="flex items-start gap-2">
            <span className="num mt-0.5 w-5 shrink-0 text-xs text-muted-foreground">{position}</span>
            <JobTitle job={job} className="flex-1" />
            {authed && job.status === 'held' && !job.approved && (
              <Button size="xs" variant="outline" onClick={() => act(`/ui/api/jobs/${job.id}/approve`, {}, 'Job approved')}><Check />Approve</Button>
            )}
            <CancelButton job={job} />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pl-7 text-xs text-muted-foreground">
            <StatusBadge status={job.status} />
            <span className="num">prio {job.priority}{effectivePriority != null && effectivePriority !== job.priority && ` → ${effectivePriority}`}</span>
            {job.approved && <StatusBadge status="approved" tone="ok" />}
            {job.advice && <span title={job.advice.reason}>advice <b className="font-medium text-foreground/80">{job.advice.action}</b></span>}
            <span className="ml-auto">for <Since iso={job.createdAt} /></span>
          </div>
          {job.holdReason && <div className="truncate pl-7 text-xs text-warn/90" title={job.holdReason}>{job.holdReason}</div>}
        </div>
      )) : <Empty>nothing waiting</Empty>}
      {board.waitingAnswer.length > 0 && <>
        <div className="flex items-center gap-2 bg-muted/30 px-4 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          On a question<span className="num font-normal text-muted-foreground/70">{board.waitingAnswer.length}</span>
        </div>
        {board.waitingAnswer.map((job) => (
          <div key={job.id} data-job-group="waitingAnswer" data-job-id={job.id} data-status={job.status} className="space-y-1.5 px-4 py-3">
            <div className="flex items-start gap-2"><JobTitle job={job} className="flex-1" /><CancelButton job={job} /></div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <a href="#questions"><StatusBadge status="waiting_answer" label="on a question →" /></a>
              <span className="ml-auto">for <Since iso={job.updatedAt} /></span>
            </div>
          </div>
        ))}
      </>}
    </Panel>
  );
}

export function EndedPanel() {
  const { ended } = useJobBoard();
  const now = useNow();
  return (
    <Panel title="Ended" icon={Archive} count={ended.length ? `${ended.length} in 24 h` : ''} bodyClassName="divide-y p-0 xl:max-h-[36rem] xl:overflow-y-auto">
      {ended.length ? ended.map((job) => (
        <div key={job.id} data-job-group="ended" data-job-id={job.id} data-status={job.status} className="space-y-1.5 px-4 py-3">
          <div className="flex items-start gap-2">
            <JobTitle job={job} className="flex-1" />
            <StatusBadge status={job.status} />
          </div>
          <div className="num flex gap-3 text-xs text-muted-foreground">
            <span title={job.finishedAt}>{ago(job.finishedAt ?? job.updatedAt, now)}</span>
            {job.startedAt && <span>took {between(job.startedAt, job.finishedAt)}</span>}
          </div>
          {job.error && <div className="line-clamp-2 text-xs text-bad/90" title={job.error}>{job.error}</div>}
        </div>
      )) : <Empty>nothing ended in 24 h</Empty>}
    </Panel>
  );
}
