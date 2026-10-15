// The job's timeline on its job view, as a Trace (issue #1169): one step line per event, newest first. A step that failed
// is an error, the newest step of a job at work runs, and a job that waits for a lane shows that wait as a pending line
// on top. Each step opens to its data in a small code block. What belongs together nests under one line
// (`model/timeline-steps.ts`): a sandbox step's start and end, and a fork's spin-off and decision, with a link to the fork job.
// A tend job and a rework job are one line each, with that job's status; opened, it links the job and reads its own events.
import { Circle, CircleCheck, CircleDot, CircleX, GitFork, GitPullRequestArrow, MessageCircleQuestion, RotateCcw, SquareTerminal, TriangleAlert, UserRound, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty } from '@/components/panel';
import { TEXT, type Tone } from '@/components/status';
import { JsonBlock } from '@/components/json-block';
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from '@/components/ui/trace';
import { subjectOf } from '@/model/board';
import { clock } from '@/model/format';
import { AT_WORK, groupStatus, timelineNodes, type StepStatus, type TimelineGroup } from '@/model/timeline-steps';
import type { DomainEvent, Job, MachineView } from '@/model/wire';
import { detailOf, eventTone } from './event-line';

const ICON: Record<Tone, LucideIcon> = {
  busy: CircleDot, ok: CircleCheck, bad: CircleX, warn: TriangleAlert, question: MessageCircleQuestion, operator: UserRound, muted: Circle,
};
const SAID: Record<StepStatus, string> = { running: 'in progress', error: 'failed', pending: 'pending' };

/** The step's status: an event that tells of a failure is an error; the newest step of a job at work runs. */
function stepStatus(e: DomainEvent, job: Job | undefined, newest: boolean): StepStatus | undefined {
  if (eventTone(e.type) === 'bad') return 'error';
  if (newest && job && AT_WORK.has(job.status)) return 'running';
  return undefined;
}

/** What a job not yet at work waits for, or nothing. */
function waitOf(job: Job | undefined): string | undefined {
  if (job?.status === 'queued') return 'waits for a lane';
  if (job?.status === 'held') return `held${job.holdReason ? `: ${job.holdReason}` : ''}`;
  return undefined;
}

type Names = { nameOf: (jobId: string) => string; machines: readonly Pick<MachineView, 'id' | 'label'>[] };

/** One event's line, which opens to its data. */
function EventStep({ e, status, nameOf, machines }: Names & { e: DomainEvent; status: StepStatus | undefined }) {
  const tone = eventTone(e.type);
  const Icon = ICON[tone];
  const detail = detailOf(e);
  const subject = subjectOf(e, nameOf, machines);
  return (
    <TraceCollapsible role="listitem" data-event-seq={e.seq}>
      <TraceCollapsibleTrigger>
        <TraceLine status={status}>
          <TraceIcon className={TEXT[tone]}><Icon /></TraceIcon>
          <TraceTitle title={detail ? `${subject} — ${detail}` : subject}>
            <span className="font-mono text-xs">{e.type}</span>
            {detail && <span> — {detail}</span>}
          </TraceTitle>
          <TraceDescription className="font-mono text-xs" title={e.at}>{clock(e.at)}</TraceDescription>
          {status && <span className="sr-only">, {SAID[status]}</span>}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent><JsonBlock value={e.data} label={`data of ${e.type}`} /></TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

const JOB_OF: Record<'fork' | 'tend' | 'rework', string> = { fork: 'fork job', tend: 'tend job', rework: 'rework job' };

/** A group's title and how it stands, in words. `itsStatus`: the status of the job a tend or rework line stands for. */
function groupWords(g: TimelineGroup, itsStatus: string | undefined): { title: string; said: string } {
  const opened = (g.opened?.data ?? {}) as Record<string, unknown>;
  const closed = g.closed?.data as Record<string, unknown> | undefined;
  if (g.group === 'step') {
    const at = { ...opened, ...closed };
    const where = str(at.box) !== undefined ? `in box ${str(at.box)!}` : str(at.template) ? `in template ${str(at.template)!}` : `on ${str(at.host) ?? 'a host'}`;
    const title = `step ${where}${str(opened.command) ? `: ${str(opened.command)!}` : ''}`;
    if (!closed) return { title, said: 'not ended' };
    return { title, said: `exit ${String(closed.exit)} after ${String(closed.seconds)} s${str(closed.problem) ? `; ${str(closed.problem)!}` : ''}` };
  }
  if (g.group === 'tend' || g.group === 'rework') {
    const what = g.group === 'tend' ? `${str(opened.step) ?? 'tend'} of ${str(opened.pullRequest) ?? 'its pull request'}` : `${str(opened.pullRequest) ?? 'its pull request'}: ${str(opened.notes) ?? ''}`;
    return { title: `${g.group} job ${g.id.slice(0, 8)}: ${what}`, said: itsStatus?.replace(/_/g, ' ') ?? 'status not known' };
  }
  const title = `${str(opened.to) ?? 'fork'} fork ${g.id.slice(0, 8)}${str(opened.note) ? `: ${str(opened.note)!}` : ''}`;
  if (!closed) return { title, said: 'not decided' };
  return { title, said: closed.decision === 'accept' ? 'accepted' : 'rejected' };
}

/** What reads a job's own events, newest first. */
export type ReadEvents = (jobId: string) => Promise<readonly DomainEvent[]>;

/** The events of the job a line stands for, read when the line opens and again when that job's status changes. */
function ItsEvents({ jobId, of, itsStatus, read, names }: { jobId: string; of: string; itsStatus: string | undefined; read: ReadEvents; names: Names }) {
  const [events, setEvents] = useState<{ jobId: string; events: readonly DomainEvent[] } | 'failed' | null>(null);
  useEffect(() => {
    let live = true;
    read(jobId).then((es) => { if (live) setEvents({ jobId, events: es }); }, () => { if (live) setEvents('failed'); });
    return () => { live = false; };
  }, [jobId, itsStatus, read]);
  if (events === 'failed') return <Empty>could not read the events of the {of}</Empty>;
  if (events?.jobId !== jobId) return <Empty>reading the events of the {of}…</Empty>;
  if (events.events.length === 0) return <Empty>no events of the {of} yet</Empty>;
  return (
    <Trace role="list" aria-label={`Events of the ${of}`}>
      {events.events.map((e) => <EventStep key={e.seq} e={e} status={eventTone(e.type) === 'bad' ? 'error' : undefined} {...names} />)}
    </Trace>
  );
}

const GROUP_ICON: Record<TimelineGroup['group'], LucideIcon> = { step: SquareTerminal, fork: GitFork, tend: GitPullRequestArrow, rework: RotateCcw };

/** A sandbox step, a fork, a tend job or a rework job: one line, which opens to its events, each a line of its own. */
function GroupStep({ g, jobStatus, statusOf, names, read }: {
  g: TimelineGroup; jobStatus: string | undefined; statusOf?: (jobId: string) => string | undefined; names: Names; read?: ReadEvents;
}) {
  const itsStatus = g.group === 'step' ? undefined : statusOf?.(g.id);
  const status = groupStatus(g, jobStatus, itsStatus);
  const { title, said } = groupWords(g, itsStatus);
  const Icon = GROUP_ICON[g.group];
  const of = g.group === 'step' ? undefined : JOB_OF[g.group];
  const newest = g.events[0]!;
  const label = `${title}, ${said}${status ? `, ${SAID[status]}` : ''}, ${g.events.length} ${g.events.length === 1 ? 'event' : 'events'}`;
  return (
    <TraceCollapsible role="listitem" data-step-key={`${g.group}:${g.id}`}>
      <TraceCollapsibleTrigger aria-label={label}>
        <TraceLine status={status}>
          <TraceIcon><Icon /></TraceIcon>
          <TraceTitle title={title}>{title}</TraceTitle>
          <TraceDescription className="text-xs">{said}</TraceDescription>
          <TraceDescription className="font-mono text-xs" title={newest.at}>{clock(newest.at)}</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="space-y-2">
        {of && <a href={`#job/${encodeURIComponent(g.id)}`} className="text-xs underline">Open the {of}</a>}
        <Trace role="list" aria-label={`Events of ${title}`}>
          {g.events.map((e) => <EventStep key={e.seq} e={e} status={eventTone(e.type) === 'bad' ? 'error' : undefined} {...names} />)}
        </Trace>
        {of && g.group !== 'fork' && read && <ItsEvents jobId={g.id} of={of} itsStatus={itsStatus} read={read} names={names} />}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

export function JobTimeline({ job, events, nameOf, machines, statusOf, readEvents }: Names & {
  job?: Job; events: readonly DomainEvent[];
  /** A job's status, when the UI holds it: a fork job, a tend job, a rework job. */
  statusOf?: (jobId: string) => string | undefined;
  /** Reads a tend or rework job's own events, when its line opens. */
  readEvents?: ReadEvents;
}) {
  const wait = waitOf(job);
  const nodes = timelineNodes(events);
  const names = { nameOf, machines };
  return (
    <div data-slot="job-timeline">
      <Trace role="list" aria-label="Job timeline">
        {wait && (
          <div role="listitem">
            <TraceLine status="pending">
              <TraceIcon><Circle /></TraceIcon>
              <TraceTitle>{wait}</TraceTitle>
              <span className="sr-only">, {SAID.pending}</span>
            </TraceLine>
          </div>
        )}
        {nodes.map((n, i) => n.kind === 'event'
          ? <EventStep key={n.event.seq} e={n.event} status={stepStatus(n.event, job, i === 0)} {...names} />
          : <GroupStep key={`${n.group}:${n.id}`} g={n} jobStatus={job?.status} statusOf={statusOf} names={names} read={readEvents} />)}
      </Trace>
      {events.length === 0 && <Empty>no events of this job yet</Empty>}
    </div>
  );
}
