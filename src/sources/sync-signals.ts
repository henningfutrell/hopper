// The sync loop's signals (sync.ts): what a source's check observed about its active jobs. A cancel ends the job; a
// finish ends a job on its own wait finished, its item closed by its own work (issue #1460).
// Assignment drift (issue #387) only marks it: `unassigned` sets `unassignedAt` and records `job.unassigned` once;
// `reassigned` clears the mark and records `job.reassigned`. The user decides whether to stop a flagged job.
import type { Clock, JobSource, SourceHost, SourceSignal } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';

// Stored rows written before 2026-10-03 may also carry reportedQuestions, answeredQuestions and
// lastProgressAt; nothing reads them.
export interface SyncFlags {
  claimReported?: boolean;
  finalReported?: boolean;
  /** Its failure was told as one the hopper fixes itself (issue #1230): told again once a person has it. */
  fixingReported?: boolean;
  cancelReason?: string;
  /** Set while a started job's item is not assigned to the account it was taken for (issue #387). */
  unassignedAt?: string;
  permanentErrors?: Array<{ kind: string; message: string }>;
}

export interface SignalsContext {
  store: SourceHost['store'];
  host: Pick<SourceHost, 'cancel' | 'finishWaiting'>;
  clock: Clock;
  enqueue(jobId: string, fn: () => Promise<void>): Promise<void>;
  write(jobId: string, flags: SyncFlags): void;
  flagsOf(job: Job): SyncFlags;
  isTerminal(job: Job): boolean;
}

/** Ask the source's check about `active` and apply each signal of one of them, on its job's report chain. */
export function signalsApplier(c: SignalsContext) {
  const { store, host, clock, write, flagsOf } = c;

  function applySignal(job: Job, s: SourceSignal) {
    const flags = flagsOf(job);
    const assignee = job.source?.assignee ?? '';
    if (s.kind === 'cancel') {
      write(job.id, { ...flags, cancelReason: s.reason });
      host.cancel(job.id, s.reason);
    } else if (s.kind === 'finish') {
      host.finishWaiting(job.id, s.reason);
    } else if (s.kind === 'unassigned' && flags.unassignedAt === undefined) {
      write(job.id, { ...flags, unassignedAt: clock.now().toISOString() });
      store.events.append({ type: 'job.unassigned', jobId: job.id, data: { assignee } });
    } else if (s.kind === 'reassigned' && flags.unassignedAt !== undefined) {
      const { unassignedAt: _gone, ...rest } = flags;
      write(job.id, rest);
      store.events.append({ type: 'job.reassigned', jobId: job.id, data: { assignee } });
    }
  }

  return async (source: JobSource, active: Job[]): Promise<void> => {
    const ids = new Set(active.map((j) => j.id));
    for (const s of await source.check(active)) {
      if (!ids.has(s.jobId)) continue;
      await c.enqueue(s.jobId, async () => {
        const job = store.jobs.get(s.jobId);
        if (job && !c.isTerminal(job)) applySignal(job, s);
      });
    }
  };
}
