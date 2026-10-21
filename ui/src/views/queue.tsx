// The Queue view (issue #159): the queue gate, the pre-sort (jobs not yet accepted, in the queue
// sorter's order) and the user order (accepted waiting jobs, first to run at the top). A job moves from
// the pre-sort into the user order to be accepted; any waiting job can be rejected, with a reason — it ends
// `rejected` and is kept, never deleted. The gate names the queue sorter that makes the pre-sort and links to
// where it is set up, Settings → Routing (issue #201). Below, the locked entries: failed jobs kept in the
// queue until run again or dismissed (issue #355), the parked jobs, out of their lanes until picked up (issue #501), and the
// jobs on their own wait, until what they wait for happens (issue #483). Each job card starts collapsed (issue #737), so the
// jobs are easy to scan and compare: its issue, state, lane, pull request, its repository's yolo mode and why it is held
// (issue #874; a gate hold with the machines' names), and in Your order its boost and a place you gave it above a
// higher-priority job (issue #1776). A job moves to any place there, and Accept puts a job at the end or at the top. A click opens one
// card for its detail; Expand all and Collapse all open or close every card. Its actions stay on the card either way.
// The issues on the backburner are no jobs, so the Queue counts them and links to Intake (issues #808, #897): never gone.
import { ArrowDown, ArrowUp, ArrowUpToLine, Check, ChevronDown, ChevronsDownUp, ChevronsRight, ChevronsUpDown, ChevronUp, Flame, Hourglass, ListOrdered, Lock, Pause, ShieldCheck, SlidersHorizontal, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { JobTitle, Since } from '@/components/job';
import { RejectButton } from '@/components/reject';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge, YoloBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get } from '@/lib/api';
import { laneName } from '@/model/board';
import { gateHoldText, heldAtGate } from '@/model/blast-radius';
import { onTheBackburner } from '@/model/intake';
import { COLLAPSED, accepting, cardOpen, moved, orderNotes, queueColumns, setAllCards, stillWhy, toggleCard, type OrderNotes } from '@/model/queue';
import type { Job, PreSort, QueueGate, QueueGateMode, YoloModeView } from '@/model/wire';
import { repoMerges } from '@/model/yolo-mode';
import { act, actFor, useHopper } from '@/store';
import { LockedRows, ParkedRows, WaitingOnRows } from './dashboard/queue';
import { TextChangeCard } from '@/components/text-change';
import { useCanAdmin, useCanOperate, useJobBoard } from '@/store/selectors';

const MODE_TEXT: Record<QueueGateMode, string> = {
  'auto-accept': 'Auto-accept — the queue sorter orders new jobs and lets them in as they arrive, and turns away what it rejects.',
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
        <span>Ordered by the queue sorter</span>
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

/** A job card (issue #737): collapsed, the essentials to compare; open, its detail too. Its actions show either way. */
function Row({ job, position, open, onToggle, yolo, children, note, flags }: {
  job: Job; position: number; open: boolean; onToggle: () => void; yolo: YoloModeView | null; children?: React.ReactNode; note?: React.ReactNode; flags?: OrderNotes;
}) {
  const machines = useHopper((s) => s.machines);
  const repo = job.source?.repo;
  // A click on the card's head opens or closes it, except on a link or a button there.
  const onHead = (e: React.MouseEvent) => { if (!(e.target as Element).closest('a, button')) onToggle(); };
  return (
    <div data-job-id={job.id} data-status={job.status} data-expanded={open} className="space-y-1.5 px-4 py-3">
      <div className="flex cursor-pointer items-start gap-2" onClick={onHead}>
        <span className="num mt-0.5 w-5 shrink-0 text-xs text-muted-foreground">{position}</span>
        <JobTitle job={job} className="min-w-0 flex-1" />
        <Button size="xs" variant="ghost" data-slot="card-toggle" aria-expanded={open} aria-label={open ? 'Collapse the card' : 'Expand the card'}
          onClick={onToggle}>{open ? <ChevronUp /> : <ChevronDown />}</Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-7 text-xs text-muted-foreground">
        <span data-slot="card-state"><StatusBadge status={job.status} /></span>
        <span data-slot="card-lane" title="its lane">{job.laneId ? laneName(job.laneId, machines) : 'no lane yet'}</span>
        {repo && yolo && <span data-slot="card-yolo"><YoloBadge on={repoMerges(yolo, repo)} /></span>}
        {flags?.boost && <span data-slot="card-boost">{flags.boost}</span>}
        {flags?.aboveHigher && <span data-slot="card-above-higher" className="text-warn/90">{flags.aboveHigher}</span>}
      </div>
      {open && (
        <div data-slot="card-detail" className="flex flex-wrap items-center gap-1.5 pl-7 text-xs text-muted-foreground">
          <span className="num">prio {job.priority}</span>
          {job.advice && <span title={job.advice.reason}>advice <b className="font-medium text-foreground/80">{job.advice.action}</b></span>}
          <span>for <Since iso={job.createdAt} /></span>
          {note}
        </div>
      )}
      {job.holdReason && (
        <div data-slot="card-hold-reason" className="pl-7 text-xs text-warn/90 [overflow-wrap:anywhere]" title={job.holdReason}>
          {heldAtGate(job) ? gateHoldText(job.holdReason, machines) : job.holdReason}
        </div>
      )}
      {children && <div className="flex flex-wrap gap-1.5 pl-7">{children}</div>}
      {job.textChange && <div className="pl-7"><TextChangeCard job={job} /></div>}
    </div>
  );
}

/** A move in the user order, to any place (issue #1776); disabled at an edge, saying so. */
function MoveButton({ label, icon, order, id, by, post }: { label: string; icon: React.ReactNode; order: readonly string[]; id: string; by: -1 | 1 | 'top'; post: (ids: string[], done: string) => unknown }) {
  const why = stillWhy(order, id, by);
  // A disabled button takes no pointer: its reason is on the span around it.
  return (
    <span title={why ? `${label}: ${why}` : label} data-slot="move-why" data-why={why}>
      <Button size="xs" variant="outline" aria-label={why ? `${label}: ${why}` : label} disabled={why !== undefined} onClick={() => post(moved(order, id, by), 'Queue ordered')}>{icon}</Button>
    </span>
  );
}

/** The order's answer (issue #1776): the jobs the queue order put lower than asked, and why. A refusal: the toast says it. */
const adjustedWhy = (answer: unknown): string | undefined => {
  const adjusted = (answer as { adjusted?: { jobId: string; why: string }[] } | null)?.adjusted ?? [];
  return adjusted.length ? `Queue ordered, but ${adjusted.map((a) => `${a.jobId}: ${a.why}`).join('; ')}` : undefined;
};

export function Queue() {
  const board = useJobBoard();
  const gate = useHopper((s) => s.gate);
  const presort = useHopper((s) => s.presort);
  const locked = useHopper((s) => s.locked);
  const backburner = useHopper((s) => onTheBackburner(s.sources));
  const operate = useCanOperate();
  const { presorted, userOrder } = queueColumns(board.waiting, presort);
  const order = userOrder.map((j) => j.id);
  const post = (ids: string[], done: string) => actFor('/ui/api/queue/order', { jobIds: ids }, done, adjustedWhy);
  const priorities = useHopper((s) => s.effectivePriority);
  const notes = orderNotes(userOrder, priorities);
  const [cards, setCards] = useState(COLLAPSED);
  const [yolo, setYolo] = useState<YoloModeView | null>(null);
  // The repositories' yolo mode, read once: without it the cards show no yolo mode.
  useEffect(() => { get<YoloModeView>('/api/yolo-mode').then(setYolo, () => {}); }, []);
  const card = (id: string) => ({ open: cardOpen(cards, id), onToggle: () => setCards((c) => toggleCard(c, id)), yolo });
  const allOpen = cards.all && Object.values(cards.own).every(Boolean);
  return (
    <div className="space-y-3">
      {/* Keyed by the saved limit: a new one resets the field. */}
      {gate && <GatePanel key={String(gate.autoAcceptPerHour)} gate={gate} presort={presort} />}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {backburner > 0 && (
          <a data-slot="queue-backburner" href="#intake" className="mr-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline">
            <Flame className="size-3.5" aria-hidden />{backburner} {backburner === 1 ? 'issue' : 'issues'} for later: not taken until you take {backburner === 1 ? 'it' : 'them'} out of Later
          </a>
        )}
        <Button size="xs" variant="outline" data-slot="cards-toggle-all" onClick={() => setCards(setAllCards(!allOpen))}>
          {allOpen ? <><ChevronsDownUp />Collapse all</> : <><ChevronsUpDown />Expand all</>}
        </Button>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Waiting to be ordered" icon={Sparkles} count={presorted.length || ''} list bodyClassName="divide-y p-0"
          action={operate && presorted.length > 0 && (
            <Button size="xs" onClick={() => act('/ui/api/queue/accept-presort', {}, 'Order accepted')} title="Accept the queue sorter's order: it rejects what it rejects and accepts the rest"><Check />Accept this order</Button>
          )}>
          {presorted.length ? presorted.map(({ job, reject }, i) => (
            <Row key={job.id} job={job} position={i + 1} {...card(job.id)}
              note={reject && <span className="text-warn" title={reject}>the sorter rejects: {reject}</span>}>
              {operate && <>
                <Button size="xs" variant="outline" onClick={() => post(accepting(order, job.id), 'Job accepted')}><ChevronsRight />Accept</Button>
                <Button size="xs" variant="outline" onClick={() => post(accepting(order, job.id, 'top'), 'Job accepted at the top')}><ArrowUpToLine />Accept at the top</Button>
                <RejectButton job={job} />
              </>}
            </Row>
          )) : <Empty>{presort ? `nothing waits for acceptance · sorted by ${presort.sorter}` : 'nothing waits for acceptance'}</Empty>}
        </Panel>
        <Panel title="Your order" icon={ListOrdered} count={userOrder.length || ''} list bodyClassName="divide-y p-0">
          {userOrder.length ? userOrder.map((job, i) => (
            <Row key={job.id} job={job} position={i + 1} {...card(job.id)} flags={notes.get(job.id)}
              note={job.userRank === undefined && <span>by the sorter</span>}>
              {operate && <>
                <MoveButton label="Move up" icon={<ArrowUp />} order={order} id={job.id} by={-1} post={post} />
                <MoveButton label="Move down" icon={<ArrowDown />} order={order} id={job.id} by={1} post={post} />
                <MoveButton label="Move to the top" icon={<ArrowUpToLine />} order={order} id={job.id} by="top" post={post} />
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
      {board.waitingOn.length > 0 && (
        <Panel title="On its own wait" icon={Hourglass} count={board.waitingOn.length} list bodyClassName="divide-y p-0">
          <WaitingOnRows heading={false} />
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
