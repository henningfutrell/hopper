// A person's resolution of a hand-off told to its job's item (issue #551), the sync loop's half: on the job's report
// chain, after the job's own end is reported — a failure told after it would put `hopper:failed` back —, at once on
// `handoff.closed` and again at each sync of its source while it is `pending`. A transient error is kept for the
// card; a permanent one ends it `failed`. A source that takes no resolution: `none`.
import { SourceError } from '../domain/ports.ts';
import type { JobSource, UserStore } from '../domain/ports.ts';
import type { DomainEvent, Handoff, HandoffResolution, Job } from '../domain/types.ts';

/** How many of the newest closed hand-offs each sync looks through for a resolution not told yet. */
const SCAN = 500;

export interface WriteBackContext {
  store: Pick<UserStore, 'handoffs' | 'jobs' | 'tx'>;
  /** Run fn on the job's report chain, so it never overlaps the job's own reports. */
  enqueue(jobId: string, fn: () => Promise<void>): Promise<void>;
  /** Whether the job's end, if it ended, is reported to its source. */
  finalReported(job: Job): boolean;
  /** The job's source while the sync loop runs it, else undefined. */
  sourceOf(jobId: string): JobSource | undefined;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createWriteBacks(c: WriteBackContext) {
  const { store } = c;

  function mark(handoffId: string, writeBack: HandoffResolution['writeBack'], error?: string) {
    store.tx(() => {
      const r = store.handoffs.get(handoffId)?.resolution;
      if (r) store.handoffs.update(handoffId, { resolution: { ...r, writeBack, writeBackError: error } });
    });
  }

  async function writeBack(source: JobSource, handoffId: string): Promise<void> {
    const h = store.handoffs.get(handoffId);
    const r = h?.resolution;
    const job = h ? store.jobs.get(h.jobId) : undefined;
    if (!r || r.writeBack !== 'pending' || !job || !c.finalReported(job)) return;
    if (!source.resolved) { mark(handoffId, 'none'); return; }
    try {
      await source.resolved(job, r);
      mark(handoffId, 'written');
    } catch (e) {
      mark(handoffId, e instanceof SourceError && e.permanent ? 'failed' : 'pending', message(e));
    }
  }

  const queue = (source: JobSource, handoffId: string, jobId: string): Promise<void> => c.enqueue(jobId, () => writeBack(source, handoffId));
  /** The resolutions of the source's jobs not told yet, newest first. */
  const pending = (source: JobSource): Handoff[] => store.handoffs.list({ status: 'closed', limit: SCAN })
    .filter((h) => h.resolution?.writeBack === 'pending' && store.jobs.get(h.jobId)?.source?.source === source.name);

  return {
    /** A sync of the source: every resolution of its jobs not told yet, tried again. */
    catchUp: async (source: JobSource): Promise<void> => { await Promise.all(pending(source).map((h) => queue(source, h.id, h.jobId))); },
    /** A hand-off closed with a resolution: told now. True when the event was one; listeners fire inside append, so never a source call from there. */
    follows(e: DomainEvent): boolean {
      if (e.type !== 'handoff.closed' || !e.jobId || typeof e.data.resolution !== 'string') return false;
      const { jobId } = e;
      const handoffId = String(e.data.handoffId);
      setImmediate(() => { const source = c.sourceOf(jobId); if (source) void queue(source, handoffId, jobId); });
      return true;
    },
  };
}
