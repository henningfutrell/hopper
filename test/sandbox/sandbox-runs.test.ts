// Issue #1349: a sandbox does one step and is burned. The sandbox module keeps each sandbox it makes for a step in the
// sandbox runs ledger — job, step, template, box, start, end, outcome — and notes when it is destroyed. A sandbox that
// outlives its step (its remove failed, or a hopper stopped mid-step) is burned by the sweep, and the ledger says so.
// The container runtime is a double at its port.
//
// Feature: sandbox runs
//   Scenario: a step's sandbox is burned after it, and the ledger has its run from start to destroy
//   Scenario: a sandbox whose remove failed after its step is burned by the next sweep
//   Scenario: a sandbox left by a hopper that stopped mid-step is burned by the sweep, its run ended as swept
//   Scenario: a step past its time limit is a timed-out run, and one the job stopped waiting for a cancelled run (issue #1371)
//   Scenario: at start, a run a stopped hopper left ends as interrupted, and its sandbox is burned (issue #1371)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxRecord } from '../../src/domain/sandboxes.ts';
import type { SandboxRepository } from '../../src/domain/store.ts';
import { NEED_LABEL } from '../../src/sandbox/need-box.ts';
import { createSandboxes } from '../../src/sandbox/service.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { memorySandboxRuns } from '../support/sandbox-runs.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function memoryRepo(): SandboxRepository {
  const rows = new Map<string, SandboxRecord>();
  return {
    list: () => [...rows.values()],
    add: (r) => (rows.has(r.id) ? false : (rows.set(r.id, r), true)),
    remove: (id) => rows.delete(id),
  };
}

const NOW = new Date('2026-10-15T12:00:00.000Z');

function setup() {
  const runtime = createFakeContainerRuntime();
  const runs = memorySandboxRuns();
  const sandboxes = createSandboxes({
    runtime, repo: memoryRepo(), runs, instanceId: 'test', network: 'host',
    clock: { now: () => NOW }, logger: { info() {}, warn() {} },
  });
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-runs-'));
  dirs.push(dir);
  const step = (name: string, id: string, o: { timeoutMs?: number; signal?: AbortSignal } = {}) => sandboxes.needStep('u1', { name, template: { image: 'img' }, env: {}, timeoutMs: o.timeoutMs ?? 5000, dir }, { log: () => {}, signal: o.signal ?? new AbortController().signal, pollMs: 5 }, { jobId: 'job-1', step: id, template: 'asked-1' });
  return { runtime, runs, sandboxes, step };
}

/** A need box of the hopper's on the runtime that no step holds: one left behind. */
async function leftBehind(runtime: FakeContainerRuntime, name: string): Promise<void> {
  await runtime.createVolume(`${name}-home`, { [NEED_LABEL]: 'test' });
  const id = await runtime.create({ name, image: 'img', network: 'host', volume: `${name}-home`, env: {}, labels: { [NEED_LABEL]: 'test' }, limits: { cpus: 1, memoryMb: 512 }, user: 'agent', script: 'true' });
  await runtime.start(id);
}

describe('sandbox runs (issue #1349)', () => {
  it('a step\'s sandbox is burned after it, and the ledger has its run from start to destroy', async () => {
    const { runtime, runs, sandboxes, step } = setup();
    const r = await step('hopper-need-asked-1-aaaa', 's-1');
    expect(r.exit).toBe(0);
    expect(runtime.boxes.size).toBe(0);
    expect(runtime.volumes.size).toBe(0);
    expect(runs.all()).toEqual([{
      id: 's-1', userId: 'u1', jobId: 'job-1', template: 'asked-1', box: 'hopper-need-asked-1-aaaa', machine: 'local',
      startedAt: NOW.toISOString(), endedAt: NOW.toISOString(), outcome: 'succeeded', exit: 0, destroyedAt: NOW.toISOString(),
    }]);
    const view = await sandboxes.view('u1');
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]).not.toHaveProperty('userId');
    expect((await sandboxes.view('u2')).runs).toEqual([]);
  });

  it('a step that failed is a failed run, burned all the same', async () => {
    const { runtime, runs, step } = setup();
    runtime.runScript = async () => ({ exit: 3, output: 'no\n' });
    expect((await step('hopper-need-asked-1-bbbb', 's-2')).exit).toBe(3);
    expect(runs.get('s-2')).toMatchObject({ outcome: 'failed', exit: 3, destroyedAt: NOW.toISOString() });
    expect(runtime.boxes.size).toBe(0);
  });

  it('a sandbox whose remove failed after its step is burned by the next sweep', async () => {
    const { runtime, runs, sandboxes, step } = setup();
    runtime.removeFails = 'the runtime is busy';
    await step('hopper-need-asked-1-cccc', 's-3');
    expect(runtime.boxes.has('hopper-need-asked-1-cccc')).toBe(true);
    expect(runs.get('s-3')).toMatchObject({ outcome: 'succeeded' });
    expect(runs.get('s-3')!.destroyedAt).toBeUndefined();

    runtime.removeFails = undefined;
    await sandboxes.check();
    expect(runtime.boxes.size).toBe(0);
    expect(runs.get('s-3')).toMatchObject({ outcome: 'succeeded', destroyedAt: NOW.toISOString() });
  });

  it('a sandbox left by a hopper that stopped mid-step is burned by the sweep, its run ended as swept', async () => {
    const { runtime, runs, sandboxes } = setup();
    runs.start({ id: 's-4', userId: 'u1', jobId: 'job-1', template: 'asked-1', box: 'hopper-need-asked-1-dddd', machine: 'local', startedAt: '2026-10-15T11:00:00.000Z' });
    await leftBehind(runtime, 'hopper-need-asked-1-dddd');
    await sandboxes.check();
    expect(runtime.boxes.size).toBe(0);
    expect(runs.get('s-4')).toMatchObject({ outcome: 'swept', endedAt: NOW.toISOString(), destroyedAt: NOW.toISOString(), problem: expect.stringContaining('burned by the sweep') });
    expect(runs.open()).toEqual([]);
  });

  it('a step past its time limit is a timed-out run, and one the job stopped waiting for a cancelled run (issue #1371)', async () => {
    const { runtime, runs, step } = setup();
    runtime.runScript = () => new Promise((resolve) => setTimeout(() => resolve({ exit: 0, output: '' }), 300));
    expect((await step('hopper-need-asked-1-eeee', 's-5', { timeoutMs: 50 })).exit).toBe(125);
    expect(runs.get('s-5')).toMatchObject({ outcome: 'timed-out', exit: 125, destroyedAt: NOW.toISOString() });

    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    expect((await step('hopper-need-asked-1-ffff', 's-6', { signal: stop.signal })).exit).toBe(125);
    expect(runs.get('s-6')).toMatchObject({ outcome: 'cancelled', exit: 125, destroyedAt: NOW.toISOString() });
    expect(runtime.boxes.size).toBe(0);
    expect(runtime.volumes.size).toBe(0);
  });

  it('at start, a run a stopped hopper left ends as interrupted, and its sandbox is burned (issue #1371)', async () => {
    const { runtime, runs, sandboxes } = setup();
    runs.start({ id: 's-7', userId: 'u1', jobId: 'job-1', template: 'asked-1', box: 'hopper-need-asked-1-gggg', machine: 'local', startedAt: '2026-10-15T11:00:00.000Z' });
    await leftBehind(runtime, 'hopper-need-asked-1-gggg');
    sandboxes.start();
    await sandboxes.stop();
    expect(runtime.boxes.size).toBe(0);
    expect(runtime.volumes.size).toBe(0);
    expect(runs.get('s-7')).toMatchObject({ outcome: 'interrupted', endedAt: NOW.toISOString(), destroyedAt: NOW.toISOString(), problem: expect.stringContaining('the hopper stopped') });
    expect(runs.open()).toEqual([]);
  });
});
