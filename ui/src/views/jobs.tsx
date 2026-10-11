// The Jobs view (issue #434): a job card per job the store holds — the queue's jobs and the locked entries — with its
// status, issue, lane and last event, the latest change first, filtered by status and by repository. Live: the store
// follows the event stream, so a status change reaches its card with no reload, and each new event of a job is its last
// event. A card renders again only when what it shows changes, so the view stays quick with hundreds of jobs.
import { Briefcase } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { detailOf, eventTone } from '@/components/event-line';
import { GhLink } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { FIELD } from '@/components/plugin-form';
import { StatusBadge, TEXT } from '@/components/status';
import { get } from '@/lib/api';
import { cn } from '@/lib/utils';
import { laneName } from '@/model/board';
import { clock } from '@/model/format';
import { goalOf, issuePointer, jobHref } from '@/model/job';
import { filterChoices, jobCards, lastEvents, NO_FILTER, type JobsFilter } from '@/model/jobs-view';
import type { DomainEvent, Job, JobStatus } from '@/model/wire';
import { useHopper } from '@/store';

interface CardProps { job: Job; lane: string; last: DomainEvent | undefined }

const same = (a: CardProps, b: CardProps): boolean =>
  a.job.id === b.job.id && a.job.updatedAt === b.job.updatedAt && a.job.status === b.job.status && a.lane === b.lane && a.last?.seq === b.last?.seq;

const JobCard = memo(function JobCard({ job, lane, last }: CardProps) {
  const pointer = issuePointer(job);
  const detail = last ? detailOf(last) : '';
  return (
    <div data-slot="job-card" data-job-id={job.id} data-status={job.status} className="min-w-0 space-y-1.5 rounded-lg border bg-card px-3 py-2.5">
      <div className="flex items-start gap-2">
        <a href={jobHref(job.id)} className="min-w-0 flex-1 truncate text-sm font-medium underline-offset-4 hover:underline" title={`${goalOf(job)}\njob ${job.id}`}>{goalOf(job)}</a>
        <StatusBadge status={job.status} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span data-slot="card-issue" className="font-mono">{pointer ? <GhLink url={pointer.url}>{pointer.label}</GhLink> : 'no issue'}</span>
        <span data-slot="card-lane" title="its lane">{lane}</span>
      </div>
      <div data-slot="card-last-event" className="flex min-w-0 items-baseline gap-2 text-xs" title={last ? `${last.at}${detail ? ` — ${detail}` : ''}` : undefined}>
        {last ? <>
          <span className="num shrink-0 font-mono text-muted-foreground/80">{clock(last.at)}</span>
          <span className={cn('shrink-0 font-mono font-medium', TEXT[eventTone(last.type)])}>{last.type}</span>
          {detail && <span className="min-w-0 truncate text-muted-foreground">{detail}</span>}
        </> : <span className="text-muted-foreground/70">no event yet</span>}
      </div>
    </div>
  );
}, same);

function Filter<T extends string>({ slot, label, value, choices, onPick }: { slot: string; label: string; value: T | null; choices: readonly T[]; onPick: (v: T | null) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">{label}
      <select data-slot={slot} className={cn(FIELD, 'w-40')} value={value ?? ''} onChange={(e) => onPick(e.target.value === '' ? null : (e.target.value as T))}>
        <option value="">all</option>
        {/* A choice no job has any more stays selectable, so the filter never changes by itself. */}
        {[...new Set([...(value ? [value] : []), ...choices])].map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
      </select>
    </label>
  );
}

export function Jobs() {
  const held = useHopper((s) => s.jobs);
  const locked = useHopper((s) => s.locked);
  const events = useHopper((s) => s.events);
  const machines = useHopper((s) => s.machines);
  const [fetched, setFetched] = useState<DomainEvent[]>([]);
  const [filter, setFilter] = useState<JobsFilter>(NO_FILTER);
  // Each job's last event, read once; the stream's events since are newer where they are a job's.
  useEffect(() => { get<{ events: DomainEvent[] }>('/api/jobs/last-events').then((r) => setFetched(r.events), () => {}); }, []);
  const jobs = useMemo(() => [...new Map([...locked, ...Object.values(held)].map((j) => [j.id, j])).values()], [held, locked]);
  const last = useMemo(() => lastEvents(fetched, events), [fetched, events]);
  const choices = useMemo(() => filterChoices(jobs), [jobs]);
  const shown = useMemo(() => jobCards(jobs, filter), [jobs, filter]);
  return (
    <Panel title="Jobs" icon={Briefcase} count={<span data-slot="jobs-count">{shown.length === jobs.length ? jobs.length : `${shown.length} of ${jobs.length}`}</span>}
      action={<div className="flex flex-wrap items-center gap-2">
        <Filter<JobStatus> slot="jobs-filter-status" label="Status" value={filter.status} choices={choices.statuses} onPick={(status) => setFilter((f) => ({ ...f, status }))} />
        <Filter<string> slot="jobs-filter-repo" label="Repository" value={filter.repo} choices={choices.repos} onPick={(repo) => setFilter((f) => ({ ...f, repo }))} />
      </div>}
      bodyClassName="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {shown.length ? shown.map((j) => (
        <JobCard key={j.id} job={j} lane={j.laneId ? laneName(j.laneId, machines) : 'no lane'} last={last.get(j.id)} />
      )) : <div className="col-span-full"><Empty>{jobs.length ? 'no job matches the filters' : 'no jobs'}</Empty></div>}
    </Panel>
  );
}
