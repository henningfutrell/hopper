// The charts' data, from the event log: ended jobs per time bucket, and what each lane ran when.
import type { DomainEvent } from './wire.ts';

export interface Bucket { start: number; finished: number; failed: number; cancelled: number }

/** Bucket starts, oldest first; the last bucket holds `now`. */
function starts(now: number, bucketMs: number, buckets: number): number[] {
  const last = Math.floor(now / bucketMs) * bucketMs;
  return Array.from({ length: buckets }, (_, i) => last - (buckets - 1 - i) * bucketMs);
}

export function throughput(events: DomainEvent[], now: number, bucketMs: number, buckets: number): Bucket[] {
  const out = starts(now, bucketMs, buckets).map((start): Bucket => ({ start, finished: 0, failed: 0, cancelled: 0 }));
  const first = out[0]?.start ?? 0;
  for (const e of events) {
    const kind = e.type === 'job.finished' ? 'finished' : e.type === 'job.failed' ? 'failed' : e.type === 'job.cancelled' ? 'cancelled' : null;
    if (!kind) continue;
    const i = Math.floor((Date.parse(e.at) - first) / bucketMs);
    const b = out[i];
    if (b) b[kind] += 1;
  }
  return out;
}

export type SpanOutcome = 'running' | 'finished' | 'failed' | 'cancelled' | 'requeued' | 'question';
export interface LaneSpan { laneId: string; jobId: string; start: number; end: number | null; outcome: SpanOutcome }

const ENDS: Partial<Record<DomainEvent['type'], SpanOutcome>> = {
  'job.finished': 'finished', 'job.failed': 'failed', 'job.cancelled': 'cancelled', 'job.requeued': 'requeued', 'question.asked': 'question',
};

/** One span per job run on a lane, in start order; spans that ended before `since` are dropped. */
export function laneSpans(events: DomainEvent[], since: number): LaneSpan[] {
  const spans: LaneSpan[] = [];
  const open = new Map<string, LaneSpan>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!e.jobId) continue;
    const starting = e.type === 'job.started' || (e.type === 'job.reattached' && !open.has(e.jobId));
    if (starting && e.laneId) {
      const span: LaneSpan = { laneId: e.laneId, jobId: e.jobId, start: Date.parse(e.at), end: null, outcome: 'running' };
      open.set(e.jobId, span);
      spans.push(span);
      continue;
    }
    const outcome = ENDS[e.type];
    const span = open.get(e.jobId);
    if (!outcome || !span) continue;
    span.end = Date.parse(e.at);
    span.outcome = outcome;
    open.delete(e.jobId);
  }
  return spans.filter((s) => s.end === null || s.end >= since);
}

/** How many spans overlap each bucket; buckets aligned as in `throughput`. */
export function concurrency(spans: LaneSpan[], now: number, bucketMs: number, buckets: number): number[] {
  return starts(now, bucketMs, buckets).map((start) =>
    spans.filter((s) => s.start < start + bucketMs && (s.end === null || s.end > start)).length);
}
