// The charts' data: ended jobs per time bucket, from the job store; what each lane ran when, from
// the event log with the job store's word on which jobs run now.
import { GROUP } from './board.ts';
import type { DomainEvent, Job, JobStatus } from './wire.ts';

export interface Bucket { start: number; finished: number; failed: number; cancelled: number }

/** Bucket starts, oldest first; the last bucket holds `now`. */
function starts(now: number, bucketMs: number, buckets: number): number[] {
  const last = Math.floor(now / bucketMs) * bucketMs;
  return Array.from({ length: buckets }, (_, i) => last - (buckets - 1 - i) * bucketMs);
}

/** `ended`: the job board's ended jobs, bucketed by status at their end. */
export function throughput(ended: Job[], now: number, bucketMs: number, buckets: number): Bucket[] {
  const out = starts(now, bucketMs, buckets).map((start): Bucket => ({ start, finished: 0, failed: 0, cancelled: 0 }));
  const first = out[0]?.start ?? 0;
  for (const j of ended) {
    if (j.status !== 'finished' && j.status !== 'failed' && j.status !== 'cancelled') continue;
    const b = out[Math.floor((Date.parse(j.finishedAt ?? j.updatedAt) - first) / bucketMs)];
    if (b) b[j.status] += 1;
  }
  return out;
}

export type SpanOutcome = 'running' | 'finished' | 'failed' | 'cancelled' | 'requeued' | 'question';
export interface LaneSpan { laneId: string; jobId: string; start: number; end: number | null; outcome: SpanOutcome }

const ENDS: Partial<Record<DomainEvent['type'], SpanOutcome>> = {
  'job.finished': 'finished', 'job.failed': 'failed', 'job.cancelled': 'cancelled', 'job.requeued': 'requeued', 'question.asked': 'question',
};

/** How a span ends when the job store says its job no longer runs. */
const LEFT: Record<JobStatus, SpanOutcome> = {
  finished: 'finished', failed: 'failed', cancelled: 'cancelled', rejected: 'cancelled', waiting_answer: 'question', queued: 'requeued', held: 'requeued',
  claimed: 'running', running: 'running',
};

/**
 * One span per job run on a lane, in start order; spans that ended before `since` are dropped.
 * `jobs` (the job store) wins over the log: an open span of a job not running there ends with the
 * job (or goes, when the store no longer holds it), and a running job the log has no start for
 * gets its span from `startedAt`. A run started again before its earlier run logged an end ends
 * that earlier span at the new start, as requeued.
 */
export function laneSpans(events: DomainEvent[], since: number, jobs: ReadonlyMap<string, Job>): LaneSpan[] {
  const spans: LaneSpan[] = [];
  const open = new Map<string, LaneSpan>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!e.jobId) continue;
    const starting = e.type === 'job.started' || (e.type === 'job.reattached' && !open.has(e.jobId));
    if (starting && e.laneId) {
      // Started again with no end logged for the earlier run (a daemon restart): that run ended here.
      const earlier = open.get(e.jobId);
      if (earlier) { earlier.end = Date.parse(e.at); earlier.outcome = 'requeued'; }
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
  for (const [jobId, span] of open) {
    const job = jobs.get(jobId);
    if (job && GROUP[job.status] === 'running') continue;
    if (!job) { spans.splice(spans.indexOf(span), 1); continue; }
    span.end = Date.parse(job.finishedAt ?? job.updatedAt);
    span.outcome = LEFT[job.status];
  }
  for (const job of jobs.values()) {
    if (GROUP[job.status] !== 'running' || open.has(job.id) || !job.laneId || !job.startedAt) continue;
    spans.push({ laneId: job.laneId, jobId: job.id, start: Date.parse(job.startedAt), end: null, outcome: 'running' });
  }
  return spans.filter((s) => s.end === null || s.end >= since).sort((a, b) => a.start - b.start);
}

/** How many spans overlap each bucket; buckets aligned as in `throughput`. */
export function concurrency(spans: LaneSpan[], now: number, bucketMs: number, buckets: number): number[] {
  return starts(now, bucketMs, buckets).map((start) =>
    spans.filter((s) => s.start < start + bucketMs && (s.end === null || s.end > start)).length);
}
