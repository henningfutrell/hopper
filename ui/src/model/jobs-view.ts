// The Jobs view (issue #434): a card per job the store holds, filtered by status and by repository, the latest change
// first, and each job's last event — the newest of what GET /api/jobs/last-events answered and the events the stream
// brought since.
import { GROUP } from './board.ts';
import type { DomainEvent, Job, JobStatus } from './wire.ts';

/** The Jobs view's filters: `null` shows every status or repository. */
export interface JobsFilter { status: JobStatus | null; repo: string | null }

export const NO_FILTER: JobsFilter = { status: null, repo: null };

/** Every status in one fixed order, as the job groups put them: the filter's choices follow it. */
const STATUS_ORDER = Object.keys(GROUP) as JobStatus[];

const repoOf = (job: Job): string | undefined => job.source?.repo;

/** The jobs the filter lets through, the latest change first. */
export function jobCards(jobs: Iterable<Job>, filter: JobsFilter): Job[] {
  const shown = [...jobs].filter((j) => (filter.status === null || j.status === filter.status) && (filter.repo === null || repoOf(j) === filter.repo));
  return shown.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The statuses and repositories the jobs have, each once: what the filters offer. */
export function filterChoices(jobs: Iterable<Job>): { statuses: JobStatus[]; repos: string[] } {
  const statuses = new Set<JobStatus>();
  const repos = new Set<string>();
  for (const j of jobs) {
    statuses.add(j.status);
    const repo = repoOf(j);
    if (repo) repos.add(repo);
  }
  return { statuses: STATUS_ORDER.filter((s) => statuses.has(s)), repos: [...repos].sort() };
}

/** The newest event of each job, over every list given; an event with no job is skipped. */
export function lastEvents(...lists: readonly (readonly DomainEvent[])[]): Map<string, DomainEvent> {
  const last = new Map<string, DomainEvent>();
  for (const list of lists) {
    for (const e of list) {
      if (e.jobId === undefined) continue;
      const held = last.get(e.jobId);
      if (!held || e.seq > held.seq) last.set(e.jobId, e);
    }
  }
  return last;
}
