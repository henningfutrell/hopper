// The outbox and the sync as telemetry (issue #1486 part 5, design.md "Telemetry: the outbox and the sync"): each outbox
// flush and each sync is a span of its own trace, linked to the action that asked for it; the GitHub calls in it are its
// children. The outbox's batches are metrics: the rows due, the calls sent, the rows coalesced away. Behaviour only:
// in-memory exporters, no timing asserted, no row text exported.
import { trace, type Span } from '@opentelemetry/api';
import { MetricReader, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OutboxChange } from '../../src/domain/github-outbox.ts';
import { createGitHubOutbox, memoryGitHubOutbox } from '../../src/sources/github/outbox.ts';
import { createSourceSync } from '../../src/sources/sync.ts';
import { startTelemetry, type Telemetry } from '../../src/telemetry/sdk.ts';
import { createFakeSource, createWorld, settle } from '../sources/sync-support.ts';

class TestReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

let spans: InMemorySpanExporter;
let reader: TestReader;
let telemetry: Telemetry;
let sync: ReturnType<typeof createSourceSync> | undefined;

beforeEach(() => {
  spans = new InMemorySpanExporter();
  reader = new TestReader();
  telemetry = startTelemetry({ env: {}, version: '0.0.0-test', spanProcessors: [new SimpleSpanProcessor(spans)], metricReaders: [reader] });
});
afterEach(async () => { await sync?.stop(); sync = undefined; await telemetry.shutdown(); });

async function metricsNow(): Promise<ResourceMetrics> {
  return (await reader.collect()).resourceMetrics;
}
function points(rm: ResourceMetrics, name: string) {
  return rm.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name)?.dataPoints ?? [];
}
const byName = (name: string): ReadableSpan[] => spans.getFinishedSpans().filter((s) => s.name === name);
const linksOf = (s: ReadableSpan): string[] => s.links.map((l) => l.context.spanId);
const tracer = () => trace.getTracer('test');
const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe('the outbox flush and the sync are spans linked to the action (issue #1486 part 5)', () => {
  function setup() {
    const world = createWorld();
    const source = createFakeSource('mine');
    source.discover = async () => {
      // A GitHub call of the sync: a client span, as the limiter makes it.
      tracer().startSpan('GitHub GET /repos/{owner}/{repo}/issues').end();
      return [];
    };
    source.intakeAction = async (a) => ({ done: [...a.keys], failed: {} });
    source.flushOutbox = async () => {
      tracer().startSpan('GitHub POST /repos/{owner}/{repo}/issues/{issue_number}/assignees').end();
      return { due: 1, wrote: ['owner/repo'] };
    };
    sync = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => 60 * 60_000, outboxBatchMs: 1 });
    return sync;
  }

  it('an intake action: its flush is a root span linked to the request, the call its child, and the sync after it linked to the request too', async () => {
    const s = setup();
    s.start();
    await settle();
    await until(() => byName('hopper.source.sync').length >= 1);
    spans.reset();

    let request!: Span;
    await tracer().startActiveSpan('POST /ui/api/sources/:name/intake', async (span) => {
      request = span;
      await s.intakeAction('mine', { kind: 'assign', keys: ['k1'] });
      span.end();
    });
    await until(() => byName('hopper.source.sync').length >= 1);
    await settle();

    const requestId = request.spanContext().spanId;
    const [flush] = byName('hopper.outbox.flush');
    expect(flush).toBeDefined();
    expect(flush!.parentSpanContext).toBeUndefined();
    expect(flush!.spanContext().traceId).not.toBe(request.spanContext().traceId);
    expect(linksOf(flush!)).toEqual([requestId]);
    expect(flush!.attributes).toMatchObject({ 'hopper.job.source': 'mine', 'hopper.outbox.due': 1 });
    const [call] = byName('GitHub POST /repos/{owner}/{repo}/issues/{issue_number}/assignees');
    expect(call!.parentSpanContext?.spanId).toBe(flush!.spanContext().spanId);

    const [synced] = byName('hopper.source.sync');
    expect(synced!.parentSpanContext).toBeUndefined();
    expect(linksOf(synced!)).toContain(requestId);
    expect(synced!.attributes).toMatchObject({ 'hopper.job.source': 'mine', 'hopper.sync.asked': false, 'hopper.sync.outcome': 'ok' });
    const [read] = byName('GitHub GET /repos/{owner}/{repo}/issues');
    expect(read!.parentSpanContext?.spanId).toBe(synced!.spanContext().spanId);
  });

  it('a sync no action asked for (the start, its timer) is linked to nothing, and a sync is never linked to the sync before it', async () => {
    const s = setup();
    s.start();
    await until(() => byName('hopper.source.sync').length >= 1);
    await s.syncNow('mine');
    const syncs = byName('hopper.source.sync');
    expect(syncs.length).toBeGreaterThanOrEqual(2);
    for (const one of syncs) {
      expect(one.parentSpanContext).toBeUndefined();
      expect(linksOf(one)).toEqual([]);
    }
    expect(syncs[0]!.attributes['hopper.sync.asked']).toBe(true);
  });

  it('a sync that fails is a span with an error outcome, and the sync duration is a metric by outcome', async () => {
    const world = createWorld();
    const failing = createFakeSource('broken');
    failing.discoverError = new Error('token ghp_secret0000 refused');
    sync = createSourceSync({ sources: [failing], host: world.host, clock: world.clock, pollMs: () => 60 * 60_000 });
    sync.start();
    await until(() => byName('hopper.source.sync').length >= 1);
    const [one] = byName('hopper.source.sync');
    expect(one!.attributes['hopper.sync.outcome']).toBe('error');
    expect(JSON.stringify(spans.getFinishedSpans().map((x) => ({ n: x.name, a: x.attributes, e: x.events, s: x.status })))).not.toContain('ghp_secret');
    const durations = points(await metricsNow(), 'hopper.source.sync.duration');
    expect(durations.some((p) => p.attributes['hopper.sync.outcome'] === 'error' && p.attributes['hopper.job.source'] === 'broken')).toBe(true);
  });
});

describe('the outbox batch as metrics (issue #1486 part 5)', () => {
  const REPO = 'owner/repo';
  const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;
  const label = (...labels: string[]) => ({ change: { op: 'add_labels', labels } as OutboxChange });

  it('counts the rows due in a batch, the calls sent, and the rows coalesced away', async () => {
    const outbox = createGitHubOutbox({ source: 'github', rows: memoryGitHubOutbox(), clock: { now: () => new Date('2026-10-17T10:00:00.000Z') } });
    outbox.queue('take_in', url(1), REPO, [label('a')]);
    outbox.queue('approve', url(1), REPO, [label('b')], { tag: 'h' });
    outbox.queue('assign', url(1), REPO, [label('c')]);
    outbox.queue('assign', url(2), REPO, [{ change: { op: 'comment', body: 'Secret text of a comment' } }]);
    let fail = false;
    await outbox.flush(async (_repo, key) => { if (fail || key === url(2)) throw new Error('boom'); });
    fail = true;

    const rm = await metricsNow();
    const sizes = points(rm, 'hopper.outbox.batch.size');
    expect(sizes).toHaveLength(1);
    expect((sizes[0]!.value as { sum: number; count: number })).toMatchObject({ sum: 4, count: 1 });
    const calls = points(rm, 'hopper.outbox.calls');
    expect(calls.find((p) => p.attributes['hopper.outbox.result'] === 'sent')?.value).toBe(1);
    expect(calls.find((p) => p.attributes['hopper.outbox.result'] === 'failed')?.value).toBe(1);
    expect(points(rm, 'hopper.outbox.rows.coalesced')[0]?.value).toBe(2);
    expect(JSON.stringify(rm)).not.toContain('Secret text');
  });

  it('an empty flush records no batch', async () => {
    const outbox = createGitHubOutbox({ source: 'github', rows: memoryGitHubOutbox(), clock: { now: () => new Date('2026-10-17T10:00:00.000Z') } });
    await outbox.flush(async () => {});
    expect(points(await metricsNow(), 'hopper.outbox.batch.size')).toEqual([]);
  });
});
