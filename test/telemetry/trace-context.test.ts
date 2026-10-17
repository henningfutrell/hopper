// A job's trace context (issue #1486 part 4, design.md "Telemetry: a job's trace on its machine"): the variables a job's
// processes run with, so what they do joins the job's trace — `TRACEPARENT` (and `TRACESTATE` when there is one), the
// environment carrier of OpenTelemetry. It names the job's open run span, else its root span while the job is open; an
// ended job, a job the hopper does not trace, and telemetry off give none. Behaviour only: in-memory exporters.
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DomainEvent, EventType, Job } from '../../src/domain/types.ts';
import { traceJobs } from '../../src/telemetry/jobs.ts';
import { startTelemetry, type Telemetry } from '../../src/telemetry/sdk.ts';

function bus() {
  const listeners = new Set<(e: DomainEvent) => void>();
  let seq = 0;
  let t = Date.parse('2026-10-17T10:00:00Z');
  return {
    subscribe: (l: (e: DomainEvent) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    emit(type: EventType, jobId = 'j1') {
      t += 1000;
      const e: DomainEvent = { schemaVersion: 1, seq: ++seq, id: `e${seq}`, type, at: new Date(t).toISOString(), jobId, data: {} };
      for (const l of listeners) l(e);
    },
  };
}

const job = (): Job => ({
  id: 'j1', spec: { executor: 'herdr-claude', payload: { prompt: 'p' } }, priority: 50, status: 'queued', approved: false,
  createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-17T10:00:00Z', attempts: 0,
});

const W3C = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/;

describe('a job\'s trace context, telemetry on (issue #1486)', () => {
  let spans: InMemorySpanExporter;
  let telemetry: Telemetry;
  beforeEach(() => {
    spans = new InMemorySpanExporter();
    telemetry = startTelemetry({ env: {}, version: '0.0.0-test', spanProcessors: [new SimpleSpanProcessor(spans)] });
  });
  afterEach(async () => { await telemetry.shutdown(); });
  const byName = (name: string): ReadableSpan[] => spans.getFinishedSpans().filter((s) => s.name === name);

  it('names the job\'s run span while it runs, its root while it waits, and nothing once it ended', () => {
    const b = bus();
    const traces = traceJobs({ subscribe: b.subscribe, job: () => job() });
    b.emit('job.queued');
    const queued = traces.traceContext('j1');
    expect(Object.keys(queued)).toEqual(['TRACEPARENT']);
    b.emit('job.started');
    const running = traces.traceContext('j1');
    b.emit('job.finished');
    expect(traces.traceContext('j1')).toEqual({});
    traces.stop();

    const [root] = byName('hopper.job');
    const [run] = byName('hopper.job.run');
    expect(W3C.exec(queued.TRACEPARENT!)?.slice(1)).toEqual([root!.spanContext().traceId, root!.spanContext().spanId]);
    expect(W3C.exec(running.TRACEPARENT!)?.slice(1)).toEqual([root!.spanContext().traceId, run!.spanContext().spanId]);
  });

  it('gives nothing for a job it does not trace', () => {
    const traces = traceJobs({ subscribe: bus().subscribe, job: () => undefined });
    expect(traces.traceContext('unknown')).toEqual({});
    traces.stop();
  });
});

describe('a job\'s trace context, telemetry off (issue #1486)', () => {
  it('is empty: the job runs with no trace variables', () => {
    const off = startTelemetry({ env: {}, version: '0.0.0-test' });
    expect(off.enabled).toBe(false);
    const b = bus();
    const traces = traceJobs({ subscribe: b.subscribe, job: () => job() });
    b.emit('job.started');
    expect(traces.traceContext('j1')).toEqual({});
    traces.stop();
  });
});
