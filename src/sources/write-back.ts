// A person's resolution of a hand-off told to its job's item (issue #551), the sync loop's half: on the job's report
// chain, after the job's own end is reported — a failure told after it would put `hopper:failed` back —, at once on
// `handoff.closed` and again at each sync of its source while it is `pending` or `failed`. The source keeps it in its
// GitHub outbox (issue #1238) and answers where it stands: `written`, `pending` with the error of the try before, or
// `failed` for good — until a person's Retry on Sources sends it again. A source that takes no resolution: `none`.
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
  /** A resolution the source keeps to send, at the hand-off's close: its source sends soon. */
  kept?(source: JobSource): void;
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

  async function writeBack(source: JobSource, handoffId: string, closed: boolean): Promise<void> {
    const h = store.handoffs.get(handoffId);
    const r = h?.resolution;
    const job = h ? store.jobs.get(h.jobId) : undefined;
    if (!r || (r.writeBack !== 'pending' && r.writeBack !== 'failed') || !job || !c.finalReported(job)) return;
    if (!source.resolved) { mark(handoffId, 'none'); return; }
    try {
      const w = await source.resolved(job, r);
      if (w.state === 'written') mark(handoffId, 'written');
      else if (w.state === 'failed') mark(handoffId, 'failed', w.error);
      else {
        if (r.writeBack !== 'pending' || r.writeBackError !== w.error) mark(handoffId, 'pending', w.error);
        // Only at its close: a sync that asks again never asks for a send, else each sync would start the next one.
        if (closed) c.kept?.(source);
      }
    } catch (e) {
      mark(handoffId, e instanceof SourceError && e.permanent ? 'failed' : 'pending', message(e));
    }
  }

  const queue = (source: JobSource, handoffId: string, jobId: string, closed = false): Promise<void> => c.enqueue(jobId, () => writeBack(source, handoffId, closed));
  /** The resolutions of the source's jobs not told yet, or failed (a person's Retry sends them again), newest first. */
  const pending = (source: JobSource): Handoff[] => store.handoffs.list({ status: 'closed', limit: SCAN })
    .filter((h) => (h.resolution?.writeBack === 'pending' || h.resolution?.writeBack === 'failed') && store.jobs.get(h.jobId)?.source?.source === source.name);

  return {
    /** A sync of the source: every resolution of its jobs not told yet, asked where it stands. */
    catchUp: async (source: JobSource): Promise<void> => { await Promise.all(pending(source).map((h) => queue(source, h.id, h.jobId))); },
    /** A hand-off closed with a resolution: told now. True when the event was one; listeners fire inside append, so never a source call from there. */
    follows(e: DomainEvent): boolean {
      if (e.type !== 'handoff.closed' || !e.jobId || typeof e.data.resolution !== 'string') return false;
      const { jobId } = e;
      const handoffId = String(e.data.handoffId);
      setImmediate(() => { const source = c.sourceOf(jobId); if (source) void queue(source, handoffId, jobId, true); });
      return true;
    },
  };
}
