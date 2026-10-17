// What the event log tells of how work goes (issue #1486, design.md "Telemetry"): failures by class and the assessor's
// decisions, retries, question escalations by level, hand-offs to a person, sandbox requests and their spin-up, landing
// batches passed and failed; and a sandbox request is a job span of its job. Behaviour only: in-memory exporters, times
// from the events, and no event text in anything exported.
import { MetricReader, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DomainEvent, EventType, Job } from '../../src/domain/types.ts';
import { traceJobs } from '../../src/telemetry/jobs.ts';
import { recordOutcomes } from '../../src/telemetry/outcomes.ts';
import { startTelemetry, type Telemetry } from '../../src/telemetry/sdk.ts';

class TestReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

let spans: InMemorySpanExporter;
let reader: TestReader;
let telemetry: Telemetry;

beforeEach(() => {
  spans = new InMemorySpanExporter();
  reader = new TestReader();
  telemetry = startTelemetry({ env: {}, version: '0.0.0-test', spanProcessors: [new SimpleSpanProcessor(spans)], metricReaders: [reader] });
});
afterEach(async () => { await telemetry.shutdown(); });

function bus() {
  const listeners = new Set<(e: DomainEvent) => void>();
  let seq = 0;
  let t = Date.parse('2026-10-16T10:00:00Z');
  return {
    subscribe: (l: (e: DomainEvent) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    emit(type: EventType, data: Record<string, unknown> = {}, more: Partial<DomainEvent> = {}) {
      t += 1000;
      const e: DomainEvent = { schemaVersion: 1, seq: ++seq, id: `e${seq}`, type, at: new Date(t).toISOString(), jobId: 'j1', data, ...more };
      for (const l of listeners) l(e);
    },
  };
}

async function metricsNow(): Promise<ResourceMetrics> {
  return (await reader.collect()).resourceMetrics;
}
function points(rm: ResourceMetrics, name: string) {
  return rm.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name)?.dataPoints ?? [];
}
const byName = (name: string): ReadableSpan[] => spans.getFinishedSpans().filter((s) => s.name === name);

describe('the event log as metrics (issue #1486)', () => {
  it('counts failures by class with the assessor\'s decision, retries, escalations by level and hand-offs', async () => {
    const b = bus();
    const stop = recordOutcomes({ subscribe: b.subscribe });
    const assessed = { recordId: 'r1', signature: 'SECRET-SIGNATURE', reasons: ['SECRET-REASON'], summary: 'SECRET-SUMMARY', attempt: 1 };
    b.emit('job.assessed', { ...assessed, class: 'transient', decision: 'retry', auto: true });
    b.emit('job.assessed', { ...assessed, class: 'transient', decision: 'retry', auto: true });
    b.emit('job.assessed', { ...assessed, class: 'job', decision: 'person', auto: false });
    b.emit('job.requeued', { from: 'running', reason: 'SECRET-REQUEUE-REASON' });
    b.emit('job.rerun', { by: 'assessor' });
    b.emit('question.escalated', { questionId: 'q1', target: 'opus', reason: 'SECRET', text: 'SECRET-QUESTION', jobId: 'j1' });
    b.emit('question.escalated', { questionId: 'q1', target: 'human', reason: 'SECRET', text: 'SECRET-QUESTION', jobId: 'j1' });
    // A re-notification is no new level.
    b.emit('question.escalated', { questionId: 'q1', target: 'human', reason: 'SECRET', text: 'SECRET-QUESTION', jobId: 'j1', renotify: true });
    b.emit('handoff.opened', { handoffId: 'h1', reason: 'retry_limit', summary: 'SECRET-SUMMARY', notify: true });
    stop();
    b.emit('job.rerun', { by: 'user' }); // stopped: not counted

    const rm = await metricsNow();
    expect(points(rm, 'hopper.job.assessed').map((p) => [p.attributes, p.value])).toEqual(expect.arrayContaining([
      [{ 'hopper.failure.class': 'transient', 'hopper.assessor.decision': 'retry', 'hopper.assessor.auto': true }, 2],
      [{ 'hopper.failure.class': 'job', 'hopper.assessor.decision': 'person', 'hopper.assessor.auto': false }, 1],
    ]));
    expect(points(rm, 'hopper.job.retries').map((p) => [p.attributes, p.value])).toEqual(expect.arrayContaining([
      [{ 'hopper.retry.kind': 'requeued', 'hopper.retry.by': 'running' }, 1],
      [{ 'hopper.retry.kind': 'rerun', 'hopper.retry.by': 'assessor' }, 1],
    ]));
    expect(points(rm, 'hopper.question.escalations').map((p) => [p.attributes, p.value])).toEqual(expect.arrayContaining([
      [{ 'hopper.question.target': 'opus' }, 1], [{ 'hopper.question.target': 'human' }, 1],
    ]));
    expect(points(rm, 'hopper.handoffs').map((p) => [p.attributes, p.value])).toEqual([[{ 'hopper.handoff.reason': 'retry_limit' }, 1]]);
    expect(JSON.stringify(rm)).not.toContain('SECRET');
  });

  it('counts sandbox requests by outcome, times a sandbox\'s spin-up from its approval, and counts landing batches by outcome', async () => {
    const b = bus();
    const stop = recordOutcomes({ subscribe: b.subscribe });
    b.emit('vault.sandbox_requested', { request: 's1', template: 'SECRET-TEMPLATE' });
    b.emit('vault.sandbox_approved', { request: 's1', template: 'SECRET-TEMPLATE', by: 'SECRET-PERSON' });
    b.emit('vault.sandbox_started', { request: 's1', template: 'SECRET-TEMPLATE', container: 'SECRET-CONTAINER' });
    b.emit('vault.sandbox_requested', { request: 's2', template: 'SECRET-TEMPLATE' });
    b.emit('vault.sandbox_declined', { request: 's2', template: 'SECRET-TEMPLATE', reason: 'SECRET', by: 'SECRET-PERSON' });
    const batch = { batchId: 'b1', repo: 'o/r', jobs: [] };
    b.emit('landing_batch.promoted', batch, { jobId: undefined });
    b.emit('landing_batch.failed', { ...batch, reason: 'SECRET-REASON', checks: ['SECRET-CHECK'] }, { jobId: undefined });
    stop();

    const rm = await metricsNow();
    expect(points(rm, 'hopper.sandbox.requests').map((p) => [p.attributes, p.value])).toEqual(expect.arrayContaining([
      [{ 'hopper.sandbox.outcome': 'started' }, 1], [{ 'hopper.sandbox.outcome': 'declined' }, 1],
    ]));
    const [spinUp] = points(rm, 'hopper.sandbox.spin_up.duration');
    expect(spinUp?.value).toMatchObject({ count: 1, sum: 1 }); // approved to started: one second of the events' time
    expect(points(rm, 'hopper.landing_batch.ended').map((p) => [p.attributes, p.value])).toEqual(expect.arrayContaining([
      [{ 'hopper.landing_batch.outcome': 'promoted' }, 1], [{ 'hopper.landing_batch.outcome': 'failed' }, 1],
    ]));
    expect(JSON.stringify(rm)).not.toContain('SECRET');
  });
});

describe('a sandbox request is a job span (issue #1486)', () => {
  const job: Job = {
    id: 'j1', spec: { executor: 'herdr-claude', payload: {} }, priority: 50, status: 'running', approved: true,
    createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z', attempts: 0,
  };

  it('from its ask to its box or its end, one per request, a child of the job\'s root, with its approval as an event', () => {
    const b = bus();
    const { stop } = traceJobs({ subscribe: b.subscribe, job: () => job });
    b.emit('job.started');
    b.emit('vault.sandbox_requested', { request: 's1', template: 'SECRET-TEMPLATE' });
    b.emit('vault.sandbox_requested', { request: 's2', template: 'SECRET-TEMPLATE' });
    b.emit('vault.sandbox_approved', { request: 's1', template: 'SECRET-TEMPLATE', by: 'SECRET-PERSON' });
    b.emit('vault.sandbox_started', { request: 's1', template: 'SECRET-TEMPLATE', container: 'SECRET-CONTAINER' });
    b.emit('vault.sandbox_failed', { request: 's2', template: 'SECRET-TEMPLATE', reason: 'SECRET-REASON' });
    b.emit('job.finished');
    stop();

    const [root] = byName('hopper.job');
    const sandboxes = byName('hopper.job.sandbox');
    expect(sandboxes.map((s) => s.attributes['hopper.job.span.ended_by']).sort()).toEqual(['vault.sandbox_failed', 'vault.sandbox_started']);
    for (const s of sandboxes) expect(s.parentSpanContext?.spanId).toBe(root!.spanContext().spanId);
    const started = sandboxes.find((s) => s.attributes['hopper.job.span.ended_by'] === 'vault.sandbox_started')!;
    expect(started.events.map((e) => e.name)).toContain('vault.sandbox_approved');
    expect(started.duration).toEqual([3, 0]); // asked at 2 s, started at 5 s
    expect(JSON.stringify(spans.getFinishedSpans().map((s) => ({ a: s.attributes, e: s.events })))).not.toContain('SECRET');
  });
});
