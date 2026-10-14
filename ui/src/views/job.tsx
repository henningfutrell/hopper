// The job view (issues #433, #935): one job, at #job/<id>, where every timeline entry about a job links — a lane timeline
// bar or question wait, an event line with a job, a job in the Jobs view. The job as the store holds it (the queue's jobs
// and locked entries), else read once from /api/jobs/:id; its state, lane, times and error. Then its parts list (GET
// /api/jobs/:id/bom, job-bom.tsx), in the order a person reads it: a plain-words header — what was asked, where it
// stands, what is next — with what waits on the person pinned under it; the job's own graph, a node per part; the
// timeline of everything that happened, newest first (the parts list's events and the ones the UI holds); and the parts
// as a filterable table. A new event of the job reads the parts list again. A direct job's job shows its promotion to
// GitHub under its facts (issue #946), as Direct jobs does. Its notes and Add note follow its facts (issue #997).
import { ArrowLeft, Briefcase } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { EventLine } from '@/components/event-line';
import { JobTitle, LinkLostFlag } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { get } from '@/lib/api';
import { laneName, machineName } from '@/model/board';
import { directJobOf } from '@/model/promotions';
import type { DomainEvent, Job } from '@/model/wire';
import { useHopper } from '@/store';
import { useJobName } from '@/store/selectors';
import { useSection } from '@/app/nav';
import { JobPromotion } from './direct-job-promotion';
import { JobNotes } from './job-notes';
import { BomGraph, BomTable, JobHeader, useJobBom, WaitingPinned } from './job-bom';

type Read = { state: 'reading' } | { state: 'found'; job: Job } | { state: 'none' };

/** The job from the store, else from the daemon; `none` when the daemon does not know it. */
function useJob(id: string): Read {
  const held = useHopper((s) => s.jobs[id] ?? s.locked.find((j) => j.id === id));
  // The answer is kept with the id it is for: another id reads as `reading` until its own answer comes.
  const [read, setRead] = useState<{ id: string; read: Read } | null>(null);
  useEffect(() => {
    if (held) return;
    let gone = false;
    get<Job>(`/api/jobs/${encodeURIComponent(id)}`).then((job) => { if (!gone) setRead({ id, read: { state: 'found', job } }); }, () => { if (!gone) setRead({ id, read: { state: 'none' } }); });
    return () => { gone = true; };
  }, [id, held]);
  if (held) return { state: 'found', job: held };
  return read?.id === id ? read.read : { state: 'reading' };
}

/** The job's events, newest first: the parts list's, the recent events and the chart history, each once. */
function useJobEvents(id: string, read: readonly DomainEvent[]): DomainEvent[] {
  const events = useHopper((s) => s.events);
  const history = useHopper((s) => s.history);
  return useMemo(() => {
    const bySeq = new Map<number, DomainEvent>();
    for (const e of [...read, ...events, ...history]) if (e.jobId === id) bySeq.set(e.seq, e);
    return [...bySeq.values()].sort((a, b) => b.seq - a.seq);
  }, [read, events, history, id]);
}

const NONE: DomainEvent[] = [];

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex gap-2 text-xs"><span className="w-20 shrink-0 text-muted-foreground">{label}</span><span className="min-w-0 break-words">{children}</span></div>
);

export function JobView() {
  const id = decodeURIComponent(useSection());
  const read = useJob(id);
  const bom = useJobBom(id);
  const events = useJobEvents(id, bom?.events ?? NONE);
  const machines = useHopper((s) => s.machines);
  const nameOf = useJobName();
  const back = <a href="#dashboard" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3" />Dashboard</a>;
  return (
    <div data-slot="job-view" data-job-id={id} className="space-y-3">
      {bom && (
        <Panel title="Where it stands" icon={Briefcase} action={back} bodyClassName="space-y-2">
          <JobHeader bom={bom} />
          <WaitingPinned bom={bom} />
        </Panel>
      )}
      <Panel title="Job" icon={bom ? undefined : Briefcase} action={bom ? undefined : back} bodyClassName="space-y-2">
        {read.state === 'reading' && <Empty>reading the job…</Empty>}
        {read.state === 'none' && <Empty>No job {id}: the hopper does not know it.</Empty>}
        {read.state === 'found' && (
          <>
            <div className="flex items-start gap-2">
              <JobTitle job={read.job} className="flex-1" />
              <StatusBadge status={read.job.status} />
            </div>
            <LinkLostFlag job={read.job} />
            <Fact label="job">{read.job.id}</Fact>
            {read.job.laneId && <Fact label="lane">{laneName(read.job.laneId, machines)}</Fact>}
            <Fact label="created">{read.job.createdAt}</Fact>
            {read.job.startedAt && <Fact label="started">{read.job.startedAt}</Fact>}
            {read.job.finishedAt && <Fact label="ended">{read.job.finishedAt}</Fact>}
            {read.job.checkpoint && (
              <Fact label="checkpoint">
                <span data-slot="checkpoint">{read.job.checkpoint.at} on {machineName(read.job.checkpoint.machineId, machines)}, {Math.ceil(read.job.checkpoint.bytes / 1024)} KiB{read.job.checkpoint.session ? '' : ', no agent session'}{read.job.checkpoint.commits.length ? `, ${read.job.checkpoint.commits.length} commits not pushed` : ''}</span>
              </Fact>
            )}
            {read.job.error && <Fact label="error"><span className="text-bad">{read.job.error}</span></Fact>}
            {directJobOf(read.job) && <JobPromotion directJobId={directJobOf(read.job)!} />}
          </>
        )}
      </Panel>
      {read.state === 'found' && <JobNotes job={read.job} />}
      {bom && <Panel title="Its parts" count={bom.parts.length} bodyClassName="p-3"><BomGraph bom={bom} title={read.state === 'found' ? read.job.spec.goal || id : id} /></Panel>}
      <Panel title="Timeline" count={events.length} bodyClassName="space-y-1 font-mono">
        <div data-slot="job-timeline" className="space-y-1">
          {events.length ? events.map((e) => <EventLine key={e.seq} e={e} nameOf={nameOf} machines={machines} />) : <Empty>no events of this job yet</Empty>}
        </div>
      </Panel>
      {bom && <Panel title="Parts list" bodyClassName="p-3"><BomTable bom={bom} /></Panel>}
    </div>
  );
}
