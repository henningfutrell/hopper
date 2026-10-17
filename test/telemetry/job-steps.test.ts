// A job step (issue #1486 part 7, design.md "Telemetry: job steps"): work the hopper does for one job outside its events
// is a span of the job's trace, a child of its open job span, linked to the span active when it began. Behaviour only:
// in-memory exporters, no timing asserted, enums only exported.
import { trace } from '@opentelemetry/api';
import { MetricReader, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeTurn } from '../../src/executors/herdr/index.ts';
import type { DomainEvent, EventType, Job } from '../../src/domain/types.ts';
import { traceJobStep } from '../../src/telemetry/job-steps.ts';
import { traceJobs, type JobTraces } from '../../src/telemetry/jobs.ts';
import { startTelemetry, type Telemetry } from '../../src/telemetry/sdk.ts';
import { telemetrySummary } from '../../src/telemetry/summary.ts';
import { LAPTOP, contextFor, jobWith, setup } from '../herdr/support.ts';

class TestReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

let spans: InMemorySpanExporter;
let reader: TestReader;
let telemetry: Telemetry;
let traces: JobTraces | undefined;

beforeEach(() => {
  spans = new InMemorySpanExporter();
  reader = new TestReader();
  telemetry = startTelemetry({ env: {}, version: '0.0.0-test', spanProcessors: [new SimpleSpanProcessor(spans)], metricReaders: [reader] });
});
afterEach(async () => { traces?.stop(); traces = undefined; await telemetry.shutdown(); });

async function metricsNow(): Promise<ResourceMetrics> {
  return (await reader.collect()).resourceMetrics;
}
const points = (rm: ResourceMetrics, name: string) => rm.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name)?.dataPoints ?? [];
const byName = (name: string): ReadableSpan[] => spans.getFinishedSpans().filter((s) => s.name === name);
const parentOf = (s: ReadableSpan): string | undefined => s.parentSpanContext?.spanId;
const tracer = () => trace.getTracer('test');

/** Follows a bus of `job`'s events, as one user's event log. */
function follow(job: (id: string) => Job | undefined = () => undefined) {
  const listeners = new Set<(e: DomainEvent) => void>();
  let seq = 0;
  traces = traceJobs({ subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; }, job });
  return (type: EventType, jobId = 'j1', data: Record<string, unknown> = {}) => {
    const e: DomainEvent = { schemaVersion: 1, seq: ++seq, id: `e${seq}`, type, at: new Date().toISOString(), jobId, data };
    for (const l of listeners) l(e);
  };
}

/** Runs `fn` in an active span, as a sync or a request runs the steps it starts. */
async function inSpan(name: string, fn: () => Promise<unknown>): Promise<ReadableSpan> {
  let id = '';
  await tracer().startActiveSpan(name, async (span) => { id = span.spanContext().spanId; await fn(); span.end(); });
  return spans.getFinishedSpans().find((s) => s.spanContext().spanId === id)!;
}

describe('a job step is a span of the job\'s trace (issue #1486 part 7)', () => {
  it('is a child of the job\'s run span, linked to the span active when it began, with its step, outcome and a duration metric', async () => {
    const emit = follow();
    emit('job.queued');
    emit('job.started');
    const sync = await inSpan('hopper.source.sync', () => traceJobStep('j1', 'worktree', async () => 'made', (o) => o));
    emit('job.finished');

    const [run] = byName('hopper.job.run');
    const [step] = byName('hopper.job.worktree');
    expect(parentOf(step!)).toBe(run!.spanContext().spanId);
    expect(step!.spanContext().traceId).toBe(run!.spanContext().traceId);
    expect(step!.links.map((l) => l.context.spanId)).toEqual([sync.spanContext().spanId]);
    expect(step!.attributes).toEqual({ 'hopper.job.id': 'j1', 'hopper.job.step': 'worktree', 'hopper.job.step.outcome': 'made' });
    const recorded = points(await metricsNow(), 'hopper.job.step.duration').map((p) => p.attributes);
    expect(recorded).toContainEqual({ 'hopper.job.step': 'worktree', 'hopper.job.step.outcome': 'made' });
    expect(telemetrySummary.read().jobSpans.map((s) => s.name)).toContain('worktree');
  });

  it('after the job ended, a step on its followed pull request is a child of the pull request span', async () => {
    const emit = follow();
    emit('job.started');
    emit('job.finished');
    emit('job.pull_request_followed', 'j1', { pullRequest: 'https://github.com/o/r/pull/3' });
    await inSpan('hopper.source.sync', () => traceJobStep('j1', 'follow', async () => 'merged_by_hopper', (o) => o, { 'hopper.pull_request.act': 'none' }));
    emit('job.pull_request_merged', 'j1', { pullRequest: 'https://github.com/o/r/pull/3' });

    const [pr] = byName('hopper.job.pull_request');
    const [step] = byName('hopper.job.follow');
    expect(parentOf(step!)).toBe(pr!.spanContext().spanId);
    expect(step!.attributes).toMatchObject({ 'hopper.pull_request.act': 'none', 'hopper.job.step.outcome': 'merged_by_hopper' });
  });

  it('a tend ends the pull request span, and the job it starts links to the tend', async () => {
    const emit = follow();
    emit('job.started');
    emit('job.finished');
    emit('job.pull_request_followed', 'j1', { pullRequest: 'https://github.com/o/r/pull/3' });
    await traceJobStep('j1', 'tend', async () => { emit('job.queued', 'j2'); return { ok: true }; }, (r) => (r.ok ? 'started' : 'refused'), { 'hopper.tend.step': 'rebase' });
    emit('job.pull_request_tended', 'j1', { pullRequest: 'https://github.com/o/r/pull/3', step: 'rebase', nextJobId: 'j2' });

    const [tend] = byName('hopper.job.tend');
    expect(tend!.attributes).toMatchObject({ 'hopper.tend.step': 'rebase', 'hopper.job.step.outcome': 'started' });
    const [pr] = byName('hopper.job.pull_request');
    expect(pr!.attributes['hopper.job.span.ended_by']).toBe('job.pull_request_tended');
    traces!.stop();
    const next = byName('hopper.job').find((s) => s.attributes['hopper.job.id'] === 'j2')!;
    expect(next.spanContext().traceId).not.toBe(tend!.spanContext().traceId);
    expect(next.links.map((l) => l.context.spanId)).toEqual([tend!.spanContext().spanId]);
  });

  it('a throw ends it as an error with its kind only, and is thrown again', async () => {
    const emit = follow();
    emit('job.started');
    await expect(traceJobStep('j1', 'base_merge', async () => { throw new TypeError('SECRET-ERROR-TEXT'); }, () => 'pushed')).rejects.toThrow('SECRET-ERROR-TEXT');
    const [step] = byName('hopper.job.base_merge');
    expect(step!.attributes).toMatchObject({ 'hopper.job.step.outcome': 'error', 'error.type': 'TypeError' });
    expect(JSON.stringify(spans.getFinishedSpans().map((s) => [s.attributes, s.events, s.status]))).not.toContain('SECRET');
  });

  it('a job no trace holds gets its step as a child of the active span, and an outcome that is no enum goes out as other', async () => {
    follow();
    const sync = await inSpan('hopper.source.sync', () => traceJobStep('gone', 'follow', async () => 'https://github.com/o/r/pull/3', (o) => o));
    const [step] = byName('hopper.job.follow');
    expect(parentOf(step!)).toBe(sync.spanContext().spanId);
    expect(step!.links).toEqual([]);
    expect(step!.attributes['hopper.job.step.outcome']).toBe('other');
  });
});

describe('the herdr start makes the job\'s worktree as a job step (issue #1486 part 7)', () => {
  it('a job from a repository: the worktree span is a child of its run span, outcome made', async () => {
    const done: FakeTurn = { output: ['● Done.', '  HOPPER_DONE'] };
    const { workTree: _none, ...bare } = LAPTOP;
    const { executor } = setup({}, { jobWorktrees: true, remote: { laptop: { turns: [done] } } });
    const fromRepo = { source: { source: 'github', kind: 'github-account', key: 'k', url: 'u', title: 'SECRET-TITLE', author: 'a', repo: 'acme/app' } };
    const { ctx } = contextFor(jobWith({ prompt: 'SECRET-PROMPT' }, fromRepo), 'laptop/lane-1', { ...bare, home: '/home/far', workTree: '/srv/trees' });
    const emit = follow();
    emit('job.started', ctx.job.id);
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    emit('job.finished', ctx.job.id);

    const [run] = byName('hopper.job.run');
    const [step] = byName('hopper.job.worktree');
    expect(parentOf(step!)).toBe(run!.spanContext().spanId);
    expect(step!.attributes).toEqual({ 'hopper.job.id': ctx.job.id, 'hopper.job.step': 'worktree', 'hopper.job.step.outcome': 'made' });
    expect(JSON.stringify(spans.getFinishedSpans().map((s) => [s.attributes, s.events]))).not.toMatch(/SECRET|\/srv\/trees/);
  });
});
