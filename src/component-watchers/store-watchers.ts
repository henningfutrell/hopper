// The watchers of the hopper's own records (issue #1077, design.md "Component watchers"): the work-item ledger against the
// job records, the lanes against the jobs they run, intake against the jobs and the sync timers, and the resource ledger
// against the ended jobs (issue #2715). Each check reads the
// store in one synchronous pass, so no event lands between its reads, and answers the drift (`src/domain/drift-jobs.ts`,
// `src/domain/drift-intake.ts`). They need no GitHub connection.
import { LANES_JOBS, LEDGER_JOBS, lanesJobsDrift, ledgerJobsDrift } from '../domain/drift-jobs.ts';
import { INTAKE_JOBS, intakeJobsDrift } from '../domain/drift-intake.ts';
import { CLEANUP_LEDGER, cleanupDrift } from '../domain/drift-cleanup.ts';
import { cleanupLeftoversOf, type ResourceLedgerRepository } from '../domain/resource-ledger.ts';
import type { IntakeOutcome } from '../domain/intake.ts';
import type { JobRepository, LaneRepository } from '../domain/store.ts';
import type { Job, JobStatus, SourceStatus } from '../domain/types.ts';
import { isActive, WORK_ITEM_STATES, type WorkItem, type WorkItemLedger } from '../domain/work-items.ts';
import type { ComponentWatcher } from './service.ts';

/** How often each checks: 5 minutes. */
export const STORE_WATCHER_INTERVAL_MS = 5 * 60_000;
/** A job or an item that changed more recently than this is no drift yet: its next step may be on its way. */
export const STORE_WATCHER_GRACE_MS = 5 * 60_000;

const ACTIVE_STATES = WORK_ITEM_STATES.filter(isActive);
/** Every status but the terminal ones (`TERMINAL_STATUSES`). */
const NOT_OVER: JobStatus[] = ['queued', 'held', 'claimed', 'running', 'waiting_answer', 'operator_led', 'parked', 'waiting_on'];

interface Options {
  jobs: Pick<JobRepository, 'get' | 'list'>;
  now(): string;
  intervalMs?: number;
  graceMs?: number;
}

export function ledgerJobsWatcher(o: Options & { ledger: Pick<WorkItemLedger, 'list' | 'get'> }): ComponentWatcher {
  return {
    name: LEDGER_JOBS,
    component: 'the work-item ledger',
    truth: 'the job records',
    intervalMs: o.intervalMs ?? STORE_WATCHER_INTERVAL_MS,
    async check() {
      const pairs = new Map<string, { item: WorkItem; job: Job | undefined }>();
      // The items a job or a person acts on, with the job each names.
      for (const item of o.ledger.list({ state: ACTIVE_STATES })) if (item.jobId) pairs.set(item.key, { item, job: o.jobs.get(item.jobId) });
      // The jobs not over, with their item when it names them.
      for (const job of o.jobs.list({ status: NOT_OVER })) {
        const key = job.source?.key;
        const item = key === undefined || pairs.has(key) ? undefined : o.ledger.get(key);
        if (item && item.jobId === job.id) pairs.set(key!, { item, job });
      }
      return ledgerJobsDrift([...pairs.values()], o.now(), o.graceMs ?? STORE_WATCHER_GRACE_MS);
    },
  };
}

export function lanesJobsWatcher(o: Options & { lanes: Pick<LaneRepository, 'list'> }): ComponentWatcher {
  return {
    name: LANES_JOBS,
    component: 'the lanes',
    truth: 'the job records',
    intervalMs: o.intervalMs ?? STORE_WATCHER_INTERVAL_MS,
    async check() {
      const lanes = o.lanes.list();
      const jobs = new Map(o.jobs.list({ status: ['claimed', 'running'] }).map((j) => [j.id, j]));
      for (const l of lanes) {
        if (!l.jobId || jobs.has(l.jobId)) continue;
        const j = o.jobs.get(l.jobId);
        if (j) jobs.set(j.id, j);
      }
      return lanesJobsDrift(lanes, [...jobs.values()], o.now(), o.graceMs ?? STORE_WATCHER_GRACE_MS);
    },
  };
}

export function intakeJobsWatcher(o: Omit<Options, 'jobs'> & { jobs: Pick<JobRepository, 'getBySourceKey'>; sources(): readonly SourceStatus[] }): ComponentWatcher {
  return {
    name: INTAKE_JOBS,
    component: 'intake',
    truth: 'the job records and the sync timers',
    intervalMs: o.intervalMs ?? STORE_WATCHER_INTERVAL_MS,
    async check() {
      const sources = o.sources();
      const jobs = new Map<string, Job>();
      for (const st of sources) {
        for (const x of Array.isArray(st.detail.intake) ? st.detail.intake as IntakeOutcome[] : []) {
          const j = x.reason === undefined ? o.jobs.getBySourceKey(x.key) : undefined;
          if (j) jobs.set(x.key, j);
        }
      }
      return intakeJobsDrift(sources, jobs, o.now(), o.graceMs ?? STORE_WATCHER_GRACE_MS);
    },
  };
}

/** The resource ledger against the ended jobs (issue #2715): a cleanup that keeps failing is a hopper bug, told as drift. */
export function cleanupJobsWatcher(o: Pick<Options, 'now' | 'intervalMs'> & { jobs: Pick<JobRepository, 'get'>; ledger: Pick<ResourceLedgerRepository, 'open'> }): ComponentWatcher {
  return {
    name: CLEANUP_LEDGER,
    component: 'the resource ledger',
    truth: 'the job records',
    intervalMs: o.intervalMs ?? STORE_WATCHER_INTERVAL_MS,
    async check() {
      return cleanupDrift(cleanupLeftoversOf(o.ledger.open(), (id) => o.jobs.get(id), Date.parse(o.now())));
    },
  };
}
