// Deploy spans (issue #1486 part 9, design.md "Telemetry: deploys"): a landing batch run is a span of its own trace, and
// each job whose pull request is in the batch gets a deploy span in its own trace, linked to the batch run. Behaviour
// only: in-memory exporters, no timing asserted, only ids, numbers and enums exported.
import { MetricReader, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DomainEvent, EventType } from '../../src/domain/types.ts';
import { traceDeploys } from '../../src/telemetry/deploys.ts';
import { traceJobs, type JobTraces } from '../../src/telemetry/jobs.ts';
import { startTelemetry, type Telemetry } from '../../src/telemetry/sdk.ts';
import { telemetrySummary } from '../../src/telemetry/summary.ts';

class TestReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

let spans: InMemorySpanExporter;
let reader: TestReader;
let telemetry: Telemetry;
let traces: JobTraces | undefined;
let stopDeploys: (() => void) | undefined;

beforeEach(() => {
  spans = new InMemorySpanExporter();
  reader = new TestReader();
  telemetry = startTelemetry({ env: {}, version: '0.0.0-test', spanProcessors: [new SimpleSpanProcessor(spans)], metricReaders: [reader] });
});
afterEach(async () => { stopDeploys?.(); stopDeploys = undefined; traces?.stop(); traces = undefined; await telemetry.shutdown(); });

const byName = (name: string): ReadableSpan[] => spans.getFinishedSpans().filter((s) => s.name === name);
async function points(name: string) {
  const rm: ResourceMetrics = (await reader.collect()).resourceMetrics;
  return rm.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name)?.dataPoints ?? [];
}

const REPO = 'acme/app';
const prUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`;
const started = (pr: number, merges: number[]) => ({ repo: REPO, landing: 'main', tested: 'dev', tip: 'abc123', branch: 'hopper-batch/abc123', pullRequest: pr, url: prUrl(pr), merges, why: 'merges' });
const ended = (pr: number) => ({ repo: REPO, tested: 'dev', tip: 'abc123', pullRequest: pr, url: prUrl(pr) });

/** One user's event log, followed by the job traces and the deploy spans, as the user's runtime does. */
function follow() {
  const listeners = new Set<(e: DomainEvent) => void>();
  const subscribe = (l: (e: DomainEvent) => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
  let seq = 0;
  traces = traceJobs({ subscribe, job: () => undefined });
  stopDeploys = traceDeploys({ subscribe, job: () => undefined });
  return (type: EventType, data: Record<string, unknown> = {}, jobId?: string) => {
    const e: DomainEvent = { schemaVersion: 1, seq: ++seq, id: `e${seq}`, type, at: new Date().toISOString(), ...(jobId ? { jobId } : {}), data };
    for (const l of listeners) l(e);
  };
}

/** A job that opened pull request `n` and ended; the hopper follows it until it merges. */
function jobWithPullRequest(emit: ReturnType<typeof follow>, jobId: string, n: number): void {
  emit('job.started', {}, jobId);
  emit('job.finished', { pullRequest: prUrl(n) }, jobId);
  emit('job.pull_request_followed', { pullRequest: prUrl(n) }, jobId);
  emit('job.pull_request_merged', { pullRequest: prUrl(n) }, jobId);
}

describe('a landing batch run is the deploy of its jobs (issue #1486 part 9)', () => {
  it('is a span of its own, and each job in the batch gets a deploy span in its own trace, linked to it', async () => {
    const emit = follow();
    jobWithPullRequest(emit, 'j1', 11);
    jobWithPullRequest(emit, 'j2', 12);
    emit('landing_batch.started', started(40, [11, 12, 13]));
    emit('landing_batch.promoted', { ...ended(40), merge: 'def456' });

    const [batch] = byName('hopper.landing_batch');
    expect(batch!.parentSpanContext).toBeUndefined();
    expect(batch!.attributes).toEqual({ 'hopper.repo': REPO, 'hopper.pull_request.number': 40, 'hopper.landing_batch.merges': 3, 'hopper.landing_batch.outcome': 'promoted' });
    const deploys = byName('hopper.job.deploy');
    expect(deploys.map((d) => d.attributes['hopper.job.id']).sort()).toEqual(['j1', 'j2']);
    for (const d of deploys) {
      const root = byName('hopper.job').find((r) => r.attributes['hopper.job.id'] === d.attributes['hopper.job.id'])!;
      expect(d.spanContext().traceId).toBe(root.spanContext().traceId);
      expect(d.links.map((l) => l.context.spanId)).toEqual([batch!.spanContext().spanId]);
      expect(d.attributes['hopper.landing_batch.outcome']).toBe('promoted');
    }
    expect((await points('hopper.landing_batch.duration')).map((p) => p.attributes)).toContainEqual({ 'hopper.landing_batch.outcome': 'promoted' });
    expect(telemetrySummary.read().jobSpans.map((s) => s.name)).toContain('deploy');
    const exported = JSON.stringify(spans.getFinishedSpans().map((s) => [s.attributes, s.events]));
    for (const word of ['hopper-batch/', 'abc123', 'def456', 'https://']) expect(exported).not.toContain(word);
  });

  it('a failed batch ends its deploys failed, and a restart ends an open one restarted', () => {
    const emit = follow();
    jobWithPullRequest(emit, 'j1', 11);
    emit('landing_batch.started', started(40, [11]));
    emit('landing_batch.failed', { ...ended(40), reason: 'checks failed', checks: ['test'] });
    emit('landing_batch.started', started(41, [11]));
    emit('landing_batch.restarted', { repo: REPO, by: 'admin', closed: [41] });

    expect(byName('hopper.landing_batch').map((s) => s.attributes['hopper.landing_batch.outcome'])).toEqual(['failed', 'restarted']);
    expect(byName('hopper.job.deploy').map((s) => s.attributes['hopper.landing_batch.outcome'])).toEqual(['failed', 'restarted']);
  });

  it('a batch of pull requests no job made has no deploy span', () => {
    const emit = follow();
    emit('landing_batch.started', started(40, [7]));
    emit('landing_batch.promoted', ended(40));
    expect(byName('hopper.landing_batch')).toHaveLength(1);
    expect(byName('hopper.job.deploy')).toEqual([]);
  });
});
