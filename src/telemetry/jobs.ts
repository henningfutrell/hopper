// A job is one trace (issue #1486, design.md "Telemetry"), built from its events as the event log appends them: a root
// span `hopper.job` from the first event seen to its end, and a job span — a child span — for each part of its life: the queue wait, each run, each
// question, each wait, each park, its pull request; each timed by the events' own times. A job's pull request is followed
// after the job ended: its job span is a child of the ended root, in the same trace, for as long as the hopper remembers
// the job (the last `max` ended). Every other event of the job is an
// event on the root span, or on its question's span. The attributes are ids and numbers only, picked by name: no event
// data, job text, prompt or error goes out. A job span's duration and a job's end are metrics too.
//
// The spans live in memory: a restart ends no trace and starts a new one at the next event of a job still open.
import { context, trace, type Attributes, type Span } from '@opentelemetry/api';
import type { DomainEvent, EventType, Job } from '../domain/types.ts';
import { instrument, tracer } from './instruments.ts';

export type JobSpan = 'queue' | 'run' | 'question' | 'wait' | 'park' | 'pull_request';

/** What starts each job span, and what ends it. A question's is keyed by its question; the others, one per job. */
const JOB_SPANS: Record<JobSpan, { start: EventType[]; end: EventType[] }> = {
  queue: { start: ['job.queued', 'job.requeued', 'job.rerun'], end: ['job.claimed', 'job.started', 'job.cancelled', 'job.rejected', 'job.parked'] },
  run: {
    start: ['job.started'],
    end: ['job.finished', 'job.failed', 'job.cancelled', 'job.waiting', 'job.parked', 'job.requeued', 'job.link_lost', 'question.asked', 'job.claimed_by_operator'],
  },
  question: { start: ['question.asked'], end: ['question.answered', 'question.closed', 'question.dismissed', 'question.expired', 'question.lapsed'] },
  wait: { start: ['job.waiting'], end: ['job.wait_ended', 'job.cancelled', 'job.failed', 'job.finished'] },
  park: { start: ['job.parked'], end: ['job.unparked', 'job.cancelled', 'job.requeued'] },
  pull_request: { start: ['job.pull_request_followed'], end: ['job.pull_request_merged', 'job.pull_request_closed', 'job.pull_request_abandoned'] },
};

const ENDED: Partial<Record<EventType, string>> = {
  'job.finished': 'finished', 'job.failed': 'failed', 'job.cancelled': 'cancelled', 'job.rejected': 'rejected', 'job.dismissed': 'dismissed',
};

/** Short values of event data that are safe to export, by key: an enum or a level, never text. */
const SAFE_DATA: Record<string, string> = { target: 'hopper.question.target', tier: 'hopper.question.tier', level: 'hopper.question.level', kind: 'hopper.failure.kind' };

const spanDuration = instrument((m) => m.createHistogram('hopper.job.span.duration', { unit: 's', description: 'How long each job span of a job lasted, by its kind.' }));
const jobsEnded = instrument((m) => m.createCounter('hopper.job.ended', { description: 'Jobs that ended, by outcome and executor.' }));
const jobEvents = instrument((m) => m.createCounter('hopper.job.events', { description: 'Job and question events, by type.' }));

interface OpenSpan { kind: JobSpan; span: Span; from: number }
interface OpenJob { root: Span; spans: Map<string, OpenSpan>; outcome?: string; executor?: string; ended?: true }

function pullRequestNumber(data: unknown): number | undefined {
  const pr = (data as { pullRequest?: unknown } | undefined)?.pullRequest;
  const n = typeof pr === 'number' ? pr : typeof pr === 'string' ? Number(/\/pull\/(\d+)/.exec(pr)?.[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function safeData(data: unknown): Attributes {
  const out: Attributes = {};
  if (!data || typeof data !== 'object') return out;
  for (const [key, name] of Object.entries(SAFE_DATA)) {
    const v = (data as Record<string, unknown>)[key];
    if ((typeof v === 'string' && /^[\w.-]{1,40}$/.test(v)) || typeof v === 'number') out[name] = v;
  }
  return out;
}

function jobAttributes(job: Job | undefined): Attributes {
  if (!job) return {};
  const s = job.source;
  return {
    'hopper.job.executor': job.spec.executor,
    ...(s?.repo ? { 'hopper.repo': s.repo } : {}),
    ...(s?.number !== undefined ? { 'hopper.issue.number': s.number } : {}),
    ...(s?.source ? { 'hopper.job.source': s.source } : {}),
    ...(job.laneId ? { 'hopper.lane.id': job.laneId } : {}),
  };
}

export interface TraceJobsOptions {
  subscribe(listener: (event: DomainEvent) => void): () => void;
  job(id: string): Job | undefined;
  /** The most jobs held open, and the most ended ones remembered; the oldest open one past it is ended and marked `hopper.trace.evicted`. */
  max?: number;
}

/** Follows one user's event log; the returned function stops it and ends every open span. */
export function traceJobs(o: TraceJobsOptions): () => void {
  const max = o.max ?? 2000;
  const jobs = new Map<string, OpenJob>();
  const ended = new Map<string, OpenJob>();

  const endSpan = (open: OpenJob, key: string, at: number, by: EventType): void => {
    const s = open.spans.get(key);
    if (!s) return;
    open.spans.delete(key);
    s.span.setAttribute('hopper.job.span.ended_by', by);
    s.span.end(at);
    spanDuration().record(Math.max(0, at - s.from) / 1000, { 'hopper.job.span': s.kind });
  };

  /** Ends the root; the job is remembered a while, for the spans that come after its end. */
  const endJob = (id: string, open: OpenJob, at: number, evicted = false): void => {
    for (const [key, s] of open.spans) if (evicted || s.kind !== 'pull_request') endSpan(open, key, at, evicted ? 'job.dismissed' : 'job.finished');
    if (open.outcome) open.root.setAttribute('hopper.job.outcome', open.outcome);
    if (evicted) open.root.setAttribute('hopper.trace.evicted', true);
    open.root.end(at);
    jobs.delete(id);
    if (evicted) return;
    open.ended = true;
    ended.delete(id);
    ended.set(id, open);
    while (ended.size > max) {
      const [oldest, held] = ended.entries().next().value!;
      for (const key of [...held.spans.keys()]) endSpan(held, key, at, 'job.dismissed');
      ended.delete(oldest);
    }
  };

  const openJob = (id: string, at: number): OpenJob => {
    const known = jobs.get(id) ?? ended.get(id);
    if (known) return known;
    if (jobs.size >= max) {
      const [oldest, held] = jobs.entries().next().value!;
      endJob(oldest, held, at, true);
    }
    const job = o.job(id);
    const root = tracer().startSpan('hopper.job', { root: true, startTime: at, attributes: { 'hopper.job.id': id, ...jobAttributes(job) } }, context.active());
    const open: OpenJob = { root, spans: new Map(), ...(job ? { executor: job.spec.executor } : {}) };
    jobs.set(id, open);
    return open;
  };

  const startSpan = (open: OpenJob, kind: JobSpan, key: string, at: number): void => {
    if (open.spans.has(key)) return;
    const span = tracer().startSpan(`hopper.job.${kind}`, { startTime: at, attributes: { 'hopper.job.span': kind } }, trace.setSpan(context.active(), open.root));
    open.spans.set(key, { kind, span, from: at });
  };

  const onEvent = (e: DomainEvent): void => {
    if (!e.jobId || !(e.type.startsWith('job.') || e.type.startsWith('question.'))) return;
    jobEvents().add(1, { 'event.name': e.type });
    const at = Date.parse(e.at);
    const open = openJob(e.jobId, at);
    // An ended root takes no more: what comes after its end goes on its open spans.
    if (!open.ended) {
      open.root.setAttributes(jobAttributes(o.job(e.jobId)));
      if (e.laneId) open.root.setAttribute('hopper.lane.id', e.laneId);
      if (e.machineId) open.root.setAttribute('hopper.machine.id', e.machineId);
    }
    const pr = pullRequestNumber(e.data);

    const questionKey = e.questionId ? `question:${e.questionId}` : undefined;
    const question = questionKey ? open.spans.get(questionKey) : undefined;
    const target = question?.span ?? (open.ended ? open.spans.get('pull_request')?.span : open.root);
    target?.addEvent(e.type, safeData(e.data), at);

    // Ends before starts: one event may end a job span and start the next.
    for (const [kind, { end }] of Object.entries(JOB_SPANS) as [JobSpan, (typeof JOB_SPANS)[JobSpan]][]) {
      if (!end.includes(e.type)) continue;
      if (kind === 'question') { if (questionKey) endSpan(open, questionKey, at, e.type); } else endSpan(open, kind, at, e.type);
    }
    for (const [kind, { start }] of Object.entries(JOB_SPANS) as [JobSpan, (typeof JOB_SPANS)[JobSpan]][]) {
      if (!start.includes(e.type)) continue;
      if (kind === 'question') { if (questionKey) startSpan(open, kind, questionKey, at); } else startSpan(open, kind, kind, at);
    }
    if (pr !== undefined) {
      open.spans.get('pull_request')?.span.setAttribute('hopper.pull_request.number', pr);
      if (!open.ended) open.root.setAttribute('hopper.pull_request.number', pr);
    }

    const outcome = ENDED[e.type];
    if (outcome && !open.ended) {
      open.outcome = outcome;
      jobsEnded().add(1, { 'hopper.job.outcome': outcome, ...(open.executor ? { 'hopper.job.executor': open.executor } : {}) });
      endJob(e.jobId, open, at);
    }
  };

  const unsubscribe = o.subscribe(onEvent);
  return () => {
    unsubscribe();
    const now = Date.now();
    for (const [id, open] of [...jobs]) endJob(id, open, now);
    for (const open of ended.values()) for (const key of [...open.spans.keys()]) endSpan(open, key, now, 'job.dismissed');
    ended.clear();
  };
}
