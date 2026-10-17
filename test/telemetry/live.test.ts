// What runs now, read at each collection (issue #1486, design.md "Telemetry: what runs now"): the sandboxes that run at
// the same time — the need boxes of steps that run, and the playground's sandboxes by state — and the store's open
// connections. Behaviour only: in-memory metric reader, the container runtime double, the real database, no timing.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetricReader, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SandboxRecord } from '../../src/domain/sandboxes.ts';
import { createPlayground, PLAYGROUND_LIMITS } from '../../src/sandbox/playground.ts';
import { createSandboxes } from '../../src/sandbox/service.ts';
import { openDb } from '../../src/store/db.ts';
import { observeLive } from '../../src/telemetry/live.ts';
import { startTelemetry, type Telemetry } from '../../src/telemetry/sdk.ts';
import { testDatabaseUrl } from '../support/database.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { memorySandboxRuns } from '../support/sandbox-runs.ts';

class TestReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

let reader: TestReader;
let telemetry: Telemetry;
let stopLive: () => void;
const dirs: string[] = [];

beforeEach(() => {
  reader = new TestReader();
  telemetry = startTelemetry({ env: {}, version: '0.0.0-test', metricReaders: [reader] });
  stopLive = observeLive();
});
afterEach(async () => {
  stopLive();
  await telemetry.shutdown();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function points(name: string) {
  const rm: ResourceMetrics = (await reader.collect()).resourceMetrics;
  return rm.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name)?.dataPoints ?? [];
}
const valueAt = async (name: string, attributes: Record<string, string>): Promise<number> =>
  (await points(name)).filter((p) => JSON.stringify(p.attributes) === JSON.stringify(attributes)).reduce((n, p) => n + (p.value as number), 0);

const logger = { info() {}, warn() {} };
const NOW = new Date('2026-10-17T12:00:00.000Z');

describe('the sandboxes that run now (issue #1486)', () => {
  it('a need box counts while its step runs, beside the hopper, and not after it', async () => {
    const runtime = createFakeContainerRuntime();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const running = new Promise<void>((r) => { started = r; });
    runtime.runScript = async () => { started(); await held; return { exit: 0, output: '' }; };
    const rows = new Map<string, SandboxRecord>();
    const sandboxes = createSandboxes({
      runtime, repo: { list: () => [...rows.values()], remove: (id) => rows.delete(id) }, runs: memorySandboxRuns(),
      instanceId: 'test', network: 'host', clock: { now: () => NOW }, logger,
    });
    const dir = mkdtempSync(join(tmpdir(), 'live-'));
    dirs.push(dir);
    sandboxes.start();
    try {
      const need = { 'hopper.sandbox.kind': 'need', 'hopper.sandbox.place': 'local', 'hopper.sandbox.state': 'running' };
      expect(await valueAt('hopper.sandboxes', need)).toBe(0);
      const step = sandboxes.needStep('u1', { name: 'hopper-need-secret-name-aaaa', template: { image: 'img' }, env: { TOKEN: 'SECRET-VALUE' }, timeoutMs: 5000, dir }, { log: () => {}, signal: new AbortController().signal, pollMs: 5 }, { jobId: 'job-1', step: 's-1', template: 'asked-1' });
      await running;
      expect(await valueAt('hopper.sandboxes', need)).toBe(1);
      const exported = JSON.stringify((await points('hopper.sandboxes')).map((p) => p.attributes));
      for (const word of ['secret-name', 'SECRET-VALUE', 'u1', 'job-1', 'asked-1']) expect(exported).not.toContain(word);
      release();
      expect((await step).exit).toBe(0);
      expect(await valueAt('hopper.sandboxes', need)).toBe(0);
    } finally {
      await sandboxes.stop();
    }
  });

  it('the playground\'s sandboxes count by state, and none once destroyed', async () => {
    const runtime = createFakeContainerRuntime();
    const p = createPlayground({ runtime, noRuntime: 'no runtime', instanceId: 'inst1', network: 'host', limits: PLAYGROUND_LIMITS, clock: { now: () => NOW }, logger });
    await p.start();
    try {
      p.create('u1', { count: 2, agent: 'claude', size: {} });
      for (let i = 0; i < 500 && (await p.view('u1')).sandboxes.some((s) => s.state === 'starting'); i++) await new Promise((r) => setTimeout(r, 5));
      const at = (state: string) => valueAt('hopper.sandboxes', { 'hopper.sandbox.kind': 'playground', 'hopper.sandbox.place': 'local', 'hopper.sandbox.state': state });
      expect(await at('running')).toBe(2);
      const [one] = (await p.view('u1')).sandboxes;
      await p.destroy('u1', [one!.id]);
      expect(await at('running')).toBe(1);
      await p.destroy('u1', (await p.view('u1')).sandboxes.map((s) => s.id));
      expect(await at('running')).toBe(0);
      expect(await at('starting')).toBe(0);
    } finally {
      await p.stop();
    }
  });
});

describe('the store\'s open connections (issue #1486)', () => {
  it('counts each store connection open, and not once it is closed; no database URL goes out', async () => {
    const url = testDatabaseUrl();
    const before = await valueAt('hopper.db.connections', {});
    const a = openDb(url), b = openDb(url);
    expect(await valueAt('hopper.db.connections', {})).toBe(before + 2);
    a.close();
    expect(await valueAt('hopper.db.connections', {})).toBe(before + 1);
    b.close();
    expect(await valueAt('hopper.db.connections', {})).toBe(before);
    const exported = JSON.stringify(await points('hopper.db.connections'));
    expect(exported).not.toContain('postgres');
  });
});
