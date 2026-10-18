// A job is one trace (issue #1486, design.md "Telemetry"), built from its events as the event log appends them: a root
// span `hopper.job` from the first event seen to its end, and a job span — a child span — for each part of its life: the queue wait, each run, each
// question, each wait, each park, each sandbox request (from its ask to its box or its end), its pull request; each timed by the events' own times. A job's pull request is followed
// after the job ended: its job span is a child of the ended root, in the same trace, for as long as the hopper remembers
// the job (the last `max` ended). Every other event of the job is an
// event on the root span, or on its question's span. The attributes are ids and numbers only, picked by name: no event
// data, job text, prompt or error goes out. A job span's duration and a job's end are metrics too; the telemetry
// summary keeps each job span's duration, telemetry on or off (`summary.ts`).
//
// The spans live in memory: a restart ends no trace and starts a new one at the next event of a job still open.
//
// A job's trace context (part 4, design.md "Telemetry: a job's trace on its machine") is the variables its processes run
// with — `TRACEPARENT`, `TRACESTATE`: OpenTelemetry's environment carrier — naming its open run span, else its root while
// the job is open. So what the job does, and its requests to the hopper, join its trace. Telemetry off, it is empty.
//
// Part 7 (design.md "Telemetry: job steps"): a job's root links to the span active at its first event, what made it (a
// request, a sync, the tend of another job's pull request); a tend ends the pull request span, as the job follows it no
// more; and the steps the hopper does for a job (`job-steps.ts`) find their parent here (`jobStepParent`).
import { context, propagation, ROOT_CONTEXT, trace, type Attributes, type Span } from '@opentelemetry/api';
import type { DomainEvent, EventType, Job } from '../domain/types.ts';
import { instrument, tracer } from './instruments.ts';
import { telemetrySummary } from './summary.ts';

export type JobSpan = 'queue' | 'run' | 'question' | 'wait' | 'park' | 'sandbox' | 'pull_request';

/** What starts each job span, and what ends it. A question's is keyed by its question, a sandbox's by its request; the others, one per job. */
const JOB_SPANS: Record<JobSpan, { start: EventType[]; end: EventType[] }> = {
  queue: { start: ['job.queued', 'job.requeued', 'job.rerun'], end: ['job.claimed', 'job.started', 'job.cancelled', 'job.rejected', 'job.parked'] },
  run: {
    start: ['job.started'],
    end: ['job.finished', 'job.failed', 'job.cancelled', 'job.waiting', 'job.parked', 'job.requeued', 'job.link_lost', 'question.asked', 'job.claimed_by_operator'],
  },
  question: { start: ['question.asked'], end: ['question.answered', 'question.closed', 'question.dismissed', 'question.expired', 'question.lapsed'] },
  wait: { start: ['job.waiting'], end: ['job.wait_ended', 'job.cancelled', 'job.failed', 'job.finished'] },
  park: { start: ['job.parked'], end: ['job.unparked', 'job.cancelled', 'job.requeued'] },
  sandbox: { start: ['vault.sandbox_requested'], end: ['vault.sandbox_started', 'vault.sandbox_failed', 'vault.sandbox_declined'] },
  // A tend hands the pull request to a new job (part 7): this job follows it no more.
  pull_request: { start: ['job.pull_request_followed'], end: ['job.pull_request_merged', 'job.pull_request_closed', 'job.pull_request_abandoned', 'job.pull_request_tended'] },
};

const ENDED: Partial<Record<EventType, string>> = {
  'job.finished': 'finished', 'job.failed': 'failed', 'job.cancelled': 'cancelled', 'job.rejected': 'rejected', 'job.dismissed': 'dismissed',
};

/** Short values of event data that are safe to export, by key: an enum or a level, never text. */
const SAFE_DATA: Record<string, string> = { target: 'hopper.question.target', tier: 'hopper.question.tier', level: 'hopper.question.level', kind: 'hopper.failure.kind' };

const spanDuration = instrument((m) => m.createHistogram('hopper.job.span.duration', { unit: 's', description: 'How long each job span of a job lasted, by its kind.' }));
const jobsEnded = instrument((m) => m.createCounter('hopper.job.ended', { description: 'Jobs that ended, by outcome and executor.' }));
const jobEvents = instrument((m) => m.createCounter('hopper.job.events', { description: 'Job, question and sandbox request events, by type.' }));

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

export interface JobTraces {
  /** The variables a job's processes run with to join its trace: none for a job ended or not traced, or telemetry off. */
  traceContext(jobId: string): Record<string, string>;
  /** Stops following the event log and ends every open span. */
  stop(): void;
}

/** Each user's job traces, for a job step's parent (`job-steps.ts`): the job's open span, if one of them holds it. */
const stepParents = new Set<(jobId: string) => Span | undefined>();

/**
 * The span a step of the job is a child of: its run, else its pull request, else its root — ended too, while the hopper
 * remembers the job, as its pull request span is (a pull request followed from the job's report has no span of its own).
 */
export function jobStepParent(jobId: string): Span | undefined {
  for (const parent of stepParents) {
    const span = parent(jobId);
    if (span) return span;
  }
  return undefined;
}

/** A propagator's field as an environment variable: `traceparent` → `TRACEPARENT`. */
const envName = (field: string): string => field.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

/** The variables that name `span` (else the active span) to a process, OpenTelemetry's environment carrier: none when no span is there. */
export function traceEnv(span: Span | undefined = trace.getActiveSpan()): Record<string, string> {
  const carrier: Record<string, string> = {};
  if (span && trace.isSpanContextValid(span.spanContext())) propagation.inject(trace.setSpan(ROOT_CONTEXT, span), carrier, { set: (c, field, value) => { c[envName(field)] = value; } });
  return carrier;
}

/** Follows one user's event log. */
export function traceJobs(o: TraceJobsOptions): JobTraces {
  const max = o.max ?? 2000;
  const jobs = new Map<string, OpenJob>();
  const ended = new Map<string, OpenJob>();

  const endSpan = (open: OpenJob, key: string, at: number, by: EventType): void => {
    const s = open.spans.get(key);
    if (!s) return;
    open.spans.delete(key);
    s.span.setAttribute('hopper.job.span.ended_by', by);
    s.span.end(at);
    const ms = Math.max(0, at - s.from);
    spanDuration().record(ms / 1000, { 'hopper.job.span': s.kind });
    telemetrySummary.jobSpan(s.kind, ms);
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
    // What made the job (part 7): a request, a sync, a tend of another job's pull request. Linked, not a parent.
    const cause = trace.getActiveSpan()?.spanContext();
    const links = cause && trace.isSpanContextValid(cause) ? [{ context: cause }] : [];
    const root = tracer().startSpan('hopper.job', { root: true, startTime: at, links, attributes: { 'hopper.job.id': id, ...jobAttributes(job) } }, context.active());
    const open: OpenJob = { root, spans: new Map(), ...(job ? { executor: job.spec.executor } : {}) };
    jobs.set(id, open);
    return open;
  };

  const startSpan = (open: OpenJob, kind: JobSpan, key: string, at: number): void => {
    if (open.spans.has(key)) return;
    const span = tracer().startSpan(`hopper.job.${kind}`, { startTime: at, attributes: { 'hopper.job.span': kind } }, trace.setSpan(context.active(), open.root));
    open.spans.set(key, { kind, span, from: at });
  };

  /** The key of a job span the event starts or ends: per question, per sandbox request, else per kind. */
  const keyOf = (kind: JobSpan, e: DomainEvent): string | undefined => {
    if (kind === 'question') return e.questionId ? `question:${e.questionId}` : undefined;
    if (kind === 'sandbox') { const r = (e.data as { request?: unknown } | undefined)?.request; return typeof r === 'string' ? `sandbox:${r}` : undefined; }
    return kind;
  };

  const onEvent = (e: DomainEvent): void => {
    if (!e.jobId || !(e.type.startsWith('job.') || e.type.startsWith('question.') || e.type.startsWith('vault.sandbox_'))) return;
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

    const own = keyOf('question', e) ?? keyOf('sandbox', e);
    const target = (own ? open.spans.get(own)?.span : undefined) ?? (open.ended ? open.spans.get('pull_request')?.span : open.root);
    target?.addEvent(e.type, safeData(e.data), at);

    // Ends before starts: one event may end a job span and start the next.
    for (const [kind, { end }] of Object.entries(JOB_SPANS) as [JobSpan, (typeof JOB_SPANS)[JobSpan]][]) {
      const key = end.includes(e.type) ? keyOf(kind, e) : undefined;
      if (key) endSpan(open, key, at, e.type);
    }
    for (const [kind, { start }] of Object.entries(JOB_SPANS) as [JobSpan, (typeof JOB_SPANS)[JobSpan]][]) {
      const key = start.includes(e.type) ? keyOf(kind, e) : undefined;
      if (key) startSpan(open, kind, key, at);
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

  const traceContext = (jobId: string): Record<string, string> => {
    const open = jobs.get(jobId);
    const span = open?.spans.get('run')?.span ?? open?.root;
    return span ? traceEnv(span) : {};
  };

  const stepParent = (jobId: string): Span | undefined => {
    const open = jobs.get(jobId) ?? ended.get(jobId);
    return open?.spans.get('run')?.span ?? open?.spans.get('pull_request')?.span ?? open?.root;
  };

  const unsubscribe = o.subscribe(onEvent);
  stepParents.add(stepParent);
  return {
    traceContext,
    stop: () => {
      unsubscribe();
      stepParents.delete(stepParent);
      const now = Date.now();
      for (const [id, open] of [...jobs]) endJob(id, open, now);
      for (const open of ended.values()) for (const key of [...open.spans.keys()]) endSpan(open, key, now, 'job.dismissed');
      ended.clear();
    },
  };
}
