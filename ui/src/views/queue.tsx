// The Queue view (issue #159): the queue gate, the pre-sort (jobs not yet accepted, in the queue
// sorter's order) and the user order (accepted waiting jobs, first to run at the top). A job moves from
// the pre-sort into the user order to be accepted; any waiting job can be rejected, with a reason — it ends
// `rejected` and is kept, never deleted. The gate names the queue sorter that makes the pre-sort and links to
// where it is set up, Settings → Routing (issue #201). Below, the locked entries: failed jobs kept in the
// queue until run again or dismissed (issue #355), and the parked jobs, out of their lanes until picked up (issue #501).
import { ArrowDown, ArrowUp, ArrowUpToLine, Check, ChevronsRight, ListOrdered, Lock, Pause, ShieldCheck, SlidersHorizontal, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { JobTitle, Since } from '@/components/job';
import { RejectButton } from '@/components/reject';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { accepting, moved, queueColumns } from '@/model/queue';
import type { Job, PreSort, QueueGate, QueueGateMode } from '@/model/wire';
import { act, useHopper } from '@/store';
import { LockedRows, ParkedRows } from './overview/queue';
import { useCanAdmin, useCanOperate, useJobBoard } from '@/store/selectors';

const MODE_TEXT: Record<QueueGateMode, string> = {
  'auto-accept': 'Auto-accept — the pre-sort lets new jobs in as they arrive, and turns away what it rejects.',
  review: 'Review — every new job waits here until you move it into your order, or reject it.',
};

function GatePanel({ gate, presort }: { gate: QueueGate; presort: PreSort | null }) {
  const admin = useCanAdmin();
  const [limit, setLimit] = useState(gate.autoAcceptPerHour?.toString() ?? '');
  const parsed = limit.trim() === '' ? null : Number(limit);
  const valid = parsed === null || (Number.isInteger(parsed) && parsed >= 1);
  const save = (next: QueueGate) => act('/ui/api/queue-gate', next, 'Queue gate saved');
  return (
    <Panel title="Queue gate" icon={ShieldCheck} bodyClassName="space-y-3">
      <div data-slot="queue-sorter" className="flex flex-wrap items-center gap-2 text-sm">
        <span>Pre-sorted by the queue sorter</span>
        {presort && <span className="font-mono">{presort.sorter}</span>}
        <Button asChild size="sm" variant="outline" className="sm:ml-auto">
          <a data-slot="queue-sorter-link" href="#settings/routing"><SlidersHorizontal />Set up the sorter</a>
        </Button>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Queue gate">
        {(['auto-accept', 'review'] as const).map((m) => (
          <Button key={m} size="lg" className="flex-1 sm:flex-none" variant={gate.mode === m ? 'default' : 'outline'} aria-pressed={gate.mode === m}
            disabled={!admin || gate.mode === m} onClick={() => void save({ ...gate, mode: m })}>{m}</Button>
        ))}
      </div>
      <div className="text-xs text-muted-foreground">{MODE_TEXT[gate.mode]}</div>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (valid) void save({ ...gate, autoAcceptPerHour: parsed }); }}>
        <label htmlFor="auto-accept-limit" className="text-sm">Auto-accept at most</label>
        <Input id="auto-accept-limit" inputMode="numeric" className="h-9 w-24" placeholder="no limit" value={limit} disabled={!admin}
          onChange={(e) => setLimit(e.target.value)} aria-invalid={!valid} />
        <span className="text-sm">jobs an hour</span>
        <Button type="submit" size="sm" variant="outline" disabled={!admin || !valid || parsed === gate.autoAcceptPerHour}>Save</Button>
      </form>
      <div className="text-xs text-muted-foreground">Past the limit, new jobs wait here for you. Leave it empty for no limit.</div>
    </Panel>
  );
}

function Row({ job, position, children, note }: { job: Job; position: number; children?: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div data-job-id={job.id} data-status={job.status} className="space-y-1.5 px-4 py-3">
      <div className="flex items-start gap-2">
        <span className="num mt-0.5 w-5 shrink-0 text-xs text-muted-foreground">{position}</span>
        <JobTitle job={job} className="min-w-0 flex-1" />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-7 text-xs text-muted-foreground">
        <span className="num">prio {job.priority}</span>
        {job.advice && <span title={job.advice.reason}>advice <b className="font-medium text-foreground/80">{job.advice.action}</b></span>}
        <span>for <Since iso={job.createdAt} /></span>
        {note}
      </div>
      {children && <div className="flex flex-wrap gap-1.5 pl-7">{children}</div>}
    </div>
  );
}

/** A move in the user order; disabled when it moves nothing (an edge of the job's priority). */
function MoveButton({ label, icon, order, next, post }: { label: string; icon: React.ReactNode; order: readonly string[]; next: string[]; post: (ids: string[], done: string) => unknown }) {
  const still = next.every((id, i) => id === order[i]);
  return <Button size="xs" variant="outline" aria-label={label} disabled={still} onClick={() => post(next, 'Queue ordered')}>{icon}</Button>;
}

export function Queue() {
  const board = useJobBoard();
  const gate = useHopper((s) => s.gate);
  const presort = useHopper((s) => s.presort);
  const locked = useHopper((s) => s.locked);
  const operate = useCanOperate();
  const { presorted, userOrder } = queueColumns(board.waiting, presort);
  const order = userOrder.map((j) => j.id);
  const post = (ids: string[], done: string) => act('/ui/api/queue/order', { jobIds: ids }, done);
  return (
    <div className="space-y-3">
      {/* Keyed by the saved limit: a new one resets the field. */}
      {gate && <GatePanel key={String(gate.autoAcceptPerHour)} gate={gate} presort={presort} />}
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Pre-sorted" icon={Sparkles} count={presorted.length || ''} list bodyClassName="divide-y p-0"
          action={operate && presorted.length > 0 && (
            <Button size="xs" onClick={() => act('/ui/api/queue/accept-presort', {}, 'Pre-sort accepted')}><Check />Accept pre-sort</Button>
          )}>
          {presorted.length ? presorted.map(({ job, reject }, i) => (
            <Row key={job.id} job={job} position={i + 1}
              note={reject && <span className="text-warn" title={reject}>pre-sort rejects: {reject}</span>}>
              {operate && <>
                <Button size="xs" variant="outline" onClick={() => post(accepting(order, job.id), 'Job accepted')}><ChevronsRight />Accept</Button>
                <RejectButton job={job} />
              </>}
            </Row>
          )) : <Empty>{presort ? `nothing waits for acceptance · sorted by ${presort.sorter}` : 'nothing waits for acceptance'}</Empty>}
        </Panel>
        <Panel title="Your order" icon={ListOrdered} count={userOrder.length || ''} list bodyClassName="divide-y p-0">
          {userOrder.length ? userOrder.map((job, i) => (
            <Row key={job.id} job={job} position={i + 1}
              note={<>{job.userRank === undefined && <span>by the sorter</span>}{job.status === 'held' && <StatusBadge status="held" />}</>}>
              {operate && <>
                <MoveButton label="Move up" icon={<ArrowUp />} order={order} next={moved(userOrder, job.id, -1)} post={post} />
                <MoveButton label="Move down" icon={<ArrowDown />} order={order} next={moved(userOrder, job.id, 1)} post={post} />
                <MoveButton label="Move to the top" icon={<ArrowUpToLine />} order={order} next={moved(userOrder, job.id, 'top')} post={post} />
                <RejectButton job={job} />
              </>}
            </Row>
          )) : <Empty>no accepted job waits</Empty>}
        </Panel>
      </div>
      {board.parked.length > 0 && (
        <Panel title="Parked" icon={Pause} count={board.parked.length} list bodyClassName="divide-y p-0">
          <ParkedRows heading={false} />
        </Panel>
      )}
      {locked.length > 0 && (
        <Panel title="Locked" icon={Lock} count={locked.length} list bodyClassName="divide-y p-0">
          <LockedRows heading={false} />
        </Panel>
      )}
    </div>
  );
}
