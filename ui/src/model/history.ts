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

export type SpanOutcome = 'running' | 'operator-led' | 'finished' | 'failed' | 'cancelled' | 'requeued' | 'question' | 'parked' | 'waiting';
/** The lane timeline's row for jobs claimed as operator-led (issue #318): worked by hand, on no lane. */
export const OPERATOR_LED_ROW = 'operator-led';

export interface LaneSpan { laneId: string; jobId: string; start: number; end: number | null; outcome: SpanOutcome }

const ENDS: Partial<Record<DomainEvent['type'], SpanOutcome>> = {
  'job.finished': 'finished', 'job.failed': 'failed', 'job.cancelled': 'cancelled', 'job.requeued': 'requeued', 'question.asked': 'question', 'job.parked': 'parked',
  // Its own wait (issue #483): it leaves its lane.
  'job.waiting': 'waiting',
};

/** How a span ends when the job store says its job no longer runs. */
const LEFT: Record<JobStatus, SpanOutcome> = {
  finished: 'finished', failed: 'failed', cancelled: 'cancelled', rejected: 'cancelled', waiting_answer: 'question', queued: 'requeued', held: 'requeued',
  claimed: 'running', running: 'running', operator_led: 'operator-led', parked: 'parked', waiting_on: 'waiting',
};

/** Whether the job store says the job still works: on a lane, or by hand. */
const stillWorks = (job: Job): boolean => GROUP[job.status] === 'running' || job.status === 'operator_led';

/**
 * One span per job run on a lane, in start order; spans that ended before `since` are dropped.
 * `jobs` (the job store) wins over the log: an open span of a job not running there ends with the
 * job (or goes, when the store no longer holds it), and a running job the log has no start for
 * gets its span from `startedAt`. A run started again before its earlier run logged an end ends
 * that earlier span at the new start, as requeued.
 */
export function laneSpans(events: DomainEvent[], since: number, jobs: ReadonlyMap<string, Job>): LaneSpan[] {
  return allSpans(events, jobs).filter((s) => s.end === null || s.end >= since);
}

function allSpans(events: DomainEvent[], jobs: ReadonlyMap<string, Job>): LaneSpan[] {
  const spans: LaneSpan[] = [];
  const open = new Map<string, LaneSpan>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (!e.jobId) continue;
    const starting = e.type === 'job.started' || (e.type === 'job.reattached' && !open.has(e.jobId));
    const byOperator = e.type === 'job.claimed_by_operator';
    if ((starting && e.laneId) || byOperator) {
      // Started again with no end logged for the earlier run (a daemon restart): that run ended here.
      const earlier = open.get(e.jobId);
      if (earlier) { earlier.end = Date.parse(e.at); earlier.outcome = 'requeued'; }
      const span: LaneSpan = byOperator
        ? { laneId: OPERATOR_LED_ROW, jobId: e.jobId, start: Date.parse(e.at), end: null, outcome: 'operator-led' }
        : { laneId: e.laneId!, jobId: e.jobId, start: Date.parse(e.at), end: null, outcome: 'running' };
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
    if (job && stillWorks(job)) continue;
    if (!job) { spans.splice(spans.indexOf(span), 1); continue; }
    span.end = Date.parse(job.finishedAt ?? job.updatedAt);
    span.outcome = LEFT[job.status];
  }
  for (const job of jobs.values()) {
    if (open.has(job.id) || !job.startedAt) continue;
    if (job.status === 'operator_led') spans.push({ laneId: OPERATOR_LED_ROW, jobId: job.id, start: Date.parse(job.startedAt), end: null, outcome: 'operator-led' });
    else if (GROUP[job.status] === 'running' && job.laneId) spans.push({ laneId: job.laneId, jobId: job.id, start: Date.parse(job.startedAt), end: null, outcome: 'running' });
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** How a question wait ended, or `waiting` while the job still sits on its question. */
export type WaitEnd = 'waiting' | 'answered' | 'closed' | 'dismissed' | 'expired' | 'lapsed' | 'parked';
export interface QuestionWait { laneId: string; jobId: string; start: number; end: number | null; how: WaitEnd }

const WAIT_ENDS: Partial<Record<DomainEvent['type'], WaitEnd>> = {
  'question.answered': 'answered', 'question.closed': 'closed', 'question.dismissed': 'dismissed', 'question.expired': 'expired',
  'question.lapsed': 'lapsed',
  // Answered in the job's pane: it runs again. A dismissed question cancels the job; an expired one fails it.
  'job.started': 'answered', 'job.reattached': 'answered', 'job.cancelled': 'dismissed', 'job.failed': 'expired',
  // Parked on its question (issue #501): it waits off its lane, its question still open.
  'job.parked': 'parked',
};

/** How a wait ends when the job store says its job no longer waits. */
const WAIT_LEFT = (status: JobStatus): WaitEnd => (status === 'cancelled' ? 'dismissed' : status === 'failed' ? 'expired' : status === 'parked' ? 'parked' : 'answered');

/**
 * One question wait per lane span that ended on a question: the job sits on it from the ask until it
 * is answered, closed, dismissed or expired (or the job runs again), drawn on the lane it asked from.
 * The job store wins, as for lane spans: an open wait of a job no longer waiting ends with the job's
 * last change, and goes when the store no longer holds the job. Waits that ended before `since` are dropped.
 */
export function questionWaits(events: DomainEvent[], since: number, jobs: ReadonlyMap<string, Job>): QuestionWait[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const waits: QuestionWait[] = [];
  for (const span of allSpans(sorted, jobs)) {
    if (span.outcome !== 'question' || span.end === null) continue;
    const start = span.end;
    const ended = sorted.find((e) => e.jobId === span.jobId && WAIT_ENDS[e.type] && Date.parse(e.at) >= start);
    if (ended) { waits.push({ laneId: span.laneId, jobId: span.jobId, start, end: Date.parse(ended.at), how: WAIT_ENDS[ended.type]! }); continue; }
    const job = jobs.get(span.jobId);
    if (!job) continue;
    if (job.status === 'waiting_answer') waits.push({ laneId: span.laneId, jobId: span.jobId, start, end: null, how: 'waiting' });
    else waits.push({ laneId: span.laneId, jobId: span.jobId, start, end: Math.max(start, Date.parse(job.updatedAt)), how: WAIT_LEFT(job.status) });
  }
  return waits.filter((w) => w.end === null || w.end >= since);
}

/** How many lane spans overlap each bucket (operator-led work holds no lane); buckets aligned as in `throughput`. */
export function concurrency(spans: LaneSpan[], now: number, bucketMs: number, buckets: number): number[] {
  const onLanes = spans.filter((s) => s.laneId !== OPERATOR_LED_ROW);
  return starts(now, bucketMs, buckets).map((start) =>
    onLanes.filter((s) => s.start < start + bucketMs && (s.end === null || s.end > start)).length);
}
