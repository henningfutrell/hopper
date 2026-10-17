// A box's own processes in the job's trace (issue #1486 part 9, design.md "Telemetry: a box's own processes"): a need box's
// run is the job step `need_box`, and the box runs with that step's trace context. Behaviour only: in-memory exporter,
// the container runtime double, no timing asserted, no secret exported.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DomainEvent, EventType } from '../../src/domain/types.ts';
import { createSandboxes } from '../../src/sandbox/service.ts';
import { traceJobs, type JobTraces } from '../../src/telemetry/jobs.ts';
import { startTelemetry, type Telemetry } from '../../src/telemetry/sdk.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { memorySandboxRuns } from '../support/sandbox-runs.ts';

let spans: InMemorySpanExporter;
let telemetry: Telemetry | undefined;
let traces: JobTraces | undefined;
const dirs: string[] = [];

beforeEach(() => { spans = new InMemorySpanExporter(); });
afterEach(async () => {
  traces?.stop(); traces = undefined;
  await telemetry?.shutdown(); telemetry = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const byName = (name: string): ReadableSpan[] => spans.getFinishedSpans().filter((s) => s.name === name);
const logger = { info() {}, warn() {} };

function follow() {
  const listeners = new Set<(e: DomainEvent) => void>();
  let seq = 0;
  traces = traceJobs({ subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; }, job: () => undefined });
  return (type: EventType, jobId = 'job-1') => {
    const e: DomainEvent = { schemaVersion: 1, seq: ++seq, id: `e${seq}`, type, at: new Date().toISOString(), jobId, data: {} };
    for (const l of listeners) l(e);
  };
}

/** Runs one need step of `job-1` beside the hopper; the box's script exits with `exit`. */
async function runStep(exit = 0) {
  const runtime = createFakeContainerRuntime();
  runtime.runScript = async () => ({ exit, output: '' });
  const sandboxes = createSandboxes({
    runtime, repo: { list: () => [], remove: () => true }, runs: memorySandboxRuns(),
    instanceId: 'test', network: 'host', clock: { now: () => new Date() }, logger,
  });
  const dir = mkdtempSync(join(tmpdir(), 'box-trace-'));
  dirs.push(dir);
  const r = await sandboxes.needStep('u1', { name: 'hopper-need-box-name-aaaa', template: { image: 'img' }, env: { TOKEN: 'SECRET-VALUE' }, timeoutMs: 5000, dir },
    { log: () => {}, signal: new AbortController().signal, pollMs: 5 }, { jobId: 'job-1', step: 's-1', template: 'asked-1' });
  await sandboxes.stop();
  return { r, env: runtime.ran.get('hopper-need-box-name-aaaa')!.env };
}

describe('a box\'s own processes join the job\'s trace (issue #1486 part 9)', () => {
  it('a need box\'s run is the step need_box, a child of the job\'s run span, and the box runs with its trace parent', async () => {
    telemetry = startTelemetry({ env: {}, version: '0.0.0-test', spanProcessors: [new SimpleSpanProcessor(spans)] });
    const emit = follow();
    emit('job.started');
    const { r, env } = await runStep();
    emit('job.finished');

    expect(r.exit).toBe(0);
    const [run] = byName('hopper.job.run');
    const [step] = byName('hopper.job.need_box');
    expect(step!.parentSpanContext?.spanId).toBe(run!.spanContext().spanId);
    expect(step!.attributes).toEqual({ 'hopper.job.id': 'job-1', 'hopper.job.step': 'need_box', 'hopper.job.step.outcome': 'succeeded', 'hopper.sandbox.place': 'local' });
    const { traceId, spanId } = step!.spanContext();
    expect(env.TRACEPARENT).toBe(`00-${traceId}-${spanId}-01`);
    expect(env.TOKEN).toBe('SECRET-VALUE');
    const exported = JSON.stringify(spans.getFinishedSpans().map((s) => [s.name, s.attributes, s.events]));
    for (const word of ['SECRET-VALUE', 'box-name', 'asked-1', 'u1']) expect(exported).not.toContain(word);
  });

  it('a box whose command fails ends the step failed', async () => {
    telemetry = startTelemetry({ env: {}, version: '0.0.0-test', spanProcessors: [new SimpleSpanProcessor(spans)] });
    follow()('job.started');
    await runStep(3);
    expect(byName('hopper.job.need_box')[0]!.attributes['hopper.job.step.outcome']).toBe('failed');
  });

  it('with telemetry off, the box gets no trace variable', async () => {
    const { env } = await runStep();
    expect(Object.keys(env).filter((k) => k.startsWith('TRACE'))).toEqual([]);
  });
});
