// The job view (issue #433): one job, at #job/<id>, where every timeline entry about a job links — a lane timeline bar
// or question wait, and an event line with a job. The job as the store holds it (the queue's jobs and locked entries),
// else read once from /api/jobs/:id; its state, lane, times and error; and its events, from the event log the UI holds.
import { ArrowLeft, Briefcase } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { EventLine } from '@/components/event-line';
import { JobTitle, LinkLostFlag } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { get } from '@/lib/api';
import { laneName } from '@/model/board';
import type { DomainEvent, Job } from '@/model/wire';
import { useHopper } from '@/store';
import { useJobName } from '@/store/selectors';
import { useSection } from '@/app/nav';

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

/** The job's events the UI holds, newest first: the recent events and the chart history, each once. */
function useJobEvents(id: string): DomainEvent[] {
  const events = useHopper((s) => s.events);
  const history = useHopper((s) => s.history);
  return useMemo(() => {
    const bySeq = new Map<number, DomainEvent>();
    for (const e of [...events, ...history]) if (e.jobId === id) bySeq.set(e.seq, e);
    return [...bySeq.values()].sort((a, b) => b.seq - a.seq);
  }, [events, history, id]);
}

const Fact = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex gap-2 text-xs"><span className="w-20 shrink-0 text-muted-foreground">{label}</span><span className="min-w-0 break-words">{children}</span></div>
);

export function JobView() {
  const id = decodeURIComponent(useSection());
  const read = useJob(id);
  const events = useJobEvents(id);
  const machines = useHopper((s) => s.machines);
  const nameOf = useJobName();
  const back = <a href="#overview" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3" />Overview</a>;
  return (
    <div data-slot="job-view" data-job-id={id} className="space-y-3">
      <Panel title="Job" icon={Briefcase} action={back} bodyClassName="space-y-2">
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
            {read.job.error && <Fact label="error"><span className="text-bad">{read.job.error}</span></Fact>}
          </>
        )}
      </Panel>
      <Panel title="Its events" count={events.length} bodyClassName="space-y-1 font-mono">
        {events.length ? events.map((e) => <EventLine key={e.seq} e={e} nameOf={nameOf} machines={machines} />) : <Empty>no events of this job in the UI's log</Empty>}
      </Panel>
    </div>
  );
}
