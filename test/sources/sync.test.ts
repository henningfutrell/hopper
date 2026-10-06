import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceError } from '../../src/domain/ports.ts';
import { createSourceSync } from '../../src/sources/sync.ts';
import { createFakeSource, createWorld, item, settle, type FakeSource, type World } from './sync-support.ts';

let sync: ReturnType<typeof createSourceSync> | undefined;
afterEach(async () => { await sync?.stop(); sync = undefined; });

async function setup(over: { sources?: FakeSource[]; start?: boolean } = {}) {
  const world: World = createWorld();
  const source = createFakeSource();
  sync = createSourceSync({
    sources: over.sources ?? [source], host: world.host, clock: world.clock,
    pollMs: () => 60_000,
  });
  if (over.start !== false) { sync.start(); await sync.syncNow(); } // initial sync (no items) done
  return { world, source, sync };
}

const kinds = (s: FakeSource) => s.reports.map((r) => r.kind);

describe('discover and ingest', () => {
  it('ingests each key once across polls and counts it', async () => {
    const { world, source, sync } = await setup();
    source.items = [item('k1'), item('k2')];
    await sync.syncNow();
    await sync.syncNow();
    expect(world.jobs.size).toBe(2);
    expect(world.calls.ingest.map((i) => i.key)).toEqual(['k1', 'k2']);
    const st = sync.statuses()[0]!;
    expect(st).toMatchObject({ itemsSeen: 2, jobsCreated: 2, activeJobs: 2, state: 'ok' });
  });

  it('hands an invalid item to the host, then reports claimed and failed once, in order', async () => {
    const { source, sync } = await setup();
    source.items = [item('bad', { invalid: 'empty issue body' })];
    await sync.syncNow();
    source.items = []; // the issue now carries hopper:failed, so the real source stops offering it
    await sync.syncNow();
    expect(kinds(source)).toEqual(['claimed', 'failed']);
  });

  it('re-sorts every discovered item that already has a job', async () => {
    const { world, source, sync } = await setup();
    source.items = [item('k1', { priority: 50 })];
    await sync.syncNow();
    source.items = [item('k1', { priority: 90, priorityReason: 'label:p0' })];
    await sync.syncNow();
    expect(world.calls.reprioritize).toEqual([['job-1', 90, 'label:p0']]);
  });
});

describe('re-run', () => {
  async function ended(status: 'failed' | 'cancelled' | 'finished') {
    const ctx = await setup();
    ctx.source.items = [item('k1')];
    await ctx.sync.syncNow();
    ctx.world.patchJob('job-1', { status });
    ctx.world.emit(`job.${status}`, 'job-1', {});
    await settle();
    return ctx;
  }

  it.each(['failed', 'cancelled', 'finished'] as const)('a %s job whose end was reported gives a rediscovered item a new job', async (status) => {
    const { world, source, sync } = await ended(status);
    expect(world.jobs.get('job-1')!.sourceState!.sync).toMatchObject({ finalReported: true });
    await sync.syncNow();
    expect(world.jobs.size).toBe(2);
    expect(world.jobs.get('job-2')).toMatchObject({ status: 'queued', source: { key: 'k1' } });
    expect(world.calls.reprioritize).toEqual([]);
    expect(sync.statuses()[0]!.jobsCreated).toBe(2);
    expect(kinds(source)).toEqual(['claimed', status, 'claimed']);
  });

  it('does not re-run while the end was not yet reported (the label write may be failing)', async () => {
    const { world, source, sync } = await setup();
    source.items = [item('k1')];
    await sync.syncNow();
    source.reportErrors = [new SourceError('boom', false, 502), new SourceError('boom', false, 502)];
    world.patchJob('job-1', { status: 'failed' });
    world.emit('job.failed', 'job-1', {});
    await settle();
    await sync.syncNow();
    expect(world.jobs.size).toBe(1);
    expect(world.calls.reprioritize).toHaveLength(1);
  });

  it('an offered item whose job ended unreported is shown in status and logged once, not dropped silently', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { world, source, sync } = await setup();
      source.items = [item('k1')];
      await sync.syncNow();
      source.reportErrors = [new SourceError('boom', false, 502), new SourceError('boom', false, 502)];
      world.patchJob('job-1', { status: 'finished' });
      world.emit('job.finished', 'job-1', {});
      await settle();
      await sync.syncNow();
      expect(world.jobs.size).toBe(1);
      expect(sync.statuses()[0]!.detail).toMatchObject({ notRerun: [{ key: 'k1', job: 'job-1', status: 'finished', reason: 'its end is not reported to the source yet' }] });
      await sync.syncNow();
      const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('k1'));
      expect(lines).toEqual(['hopper: k1 not run again: job job-1 finished, its end is not reported to the source yet']);
    } finally {
      spy.mockRestore();
    }
  });

  it('re-runs once: the new job is the newest, so a live one is only re-sorted', async () => {
    const { world, sync } = await ended('failed');
    await sync.syncNow();
    await sync.syncNow();
    expect(world.jobs.size).toBe(2);
    expect(world.calls.reprioritize.map((c) => c[0])).toEqual(['job-2']);
  });
});

describe('reports', () => {
  it('reports the claim once and replaces the source state rather than merging', async () => {
    const { world, source, sync } = await setup();
    source.items = [item('k1')];
    await sync.syncNow();
    await sync.syncNow();
    expect(kinds(source)).toEqual(['claimed']);
    expect(world.jobs.get('job-1')!.sourceState).toEqual({
      sync: expect.objectContaining({ claimReported: true }), source: { n1: 'claimed' },
    });
    world.emit('job.finished', 'job-1', { result: 'ok' });
    world.patchJob('job-1', { status: 'finished' });
    await settle();
    expect(world.jobs.get('job-1')!.sourceState!.source).toEqual({ n2: 'finished' });
  });

  it('retries a transient report failure on the next sync', async () => {
    const { source, sync } = await setup();
    source.reportErrors = [new SourceError('boom', false, 502)];
    source.items = [item('k1')];
    await sync.syncNow();
    expect(kinds(source)).toEqual([]);
    await sync.syncNow();
    expect(kinds(source)).toEqual(['claimed']);
  });

  it('never retries a permanent report failure and shows it in status detail', async () => {
    const { source, sync } = await setup();
    source.reportErrors = [new SourceError('issue gone', true, 404)];
    source.items = [item('k1')];
    await sync.syncNow();
    await sync.syncNow();
    expect(kinds(source)).toEqual([]);
    expect(sync.statuses()[0]!.detail).toMatchObject({ permanentErrors: 1 });
  });

  it('reports a job that ended while the daemon was down (crash after finish)', async () => {
    const { world, source, sync } = await setup();
    source.items = [item('k1')];
    await sync.syncNow();
    world.patchJob('job-1', { status: 'finished' });
    await sync.syncNow();
    source.items = []; // the issue is now closed with hopper:done, so the real source stops offering it
    await sync.syncNow();
    expect(kinds(source)).toEqual(['claimed', 'finished']);
  });

  it('reports neither progress nor questions nor answers: only the claim and the end', async () => {
    const { world, source, sync } = await setup();
    source.items = [item('k1')];
    await sync.syncNow();
    world.patchJob('job-1', { status: 'running', progressMessage: 'a' });
    world.emit('job.progressed', 'job-1', { progress: 0.1 });
    world.patchJob('job-1', { status: 'waiting_answer' });
    const q = world.addQuestion('job-1');
    world.emit('question.escalated', 'job-1', { target: 'human' }, q.id);
    world.questions.set(q.id, { ...q, status: 'answered', answer: 'yes', answeredBy: 'human' });
    world.emit('question.answered', 'job-1', {}, q.id);
    await settle();
    await sync.syncNow();
    expect(kinds(source)).toEqual(['claimed']);
  });

  it('reports finished, failed and cancelled', async () => {
    const { world, source, sync } = await setup();
    source.items = [item('a'), item('b'), item('c')];
    await sync.syncNow();
    world.patchJob('job-1', { status: 'finished' });
    world.emit('job.finished', 'job-1', {});
    world.patchJob('job-2', { status: 'failed', error: 'x' });
    world.emit('job.failed', 'job-2', { error: 'x' });
    world.patchJob('job-3', { status: 'cancelled' });
    world.emit('job.cancelled', 'job-3', { reason: 'cancelled in UI' });
    await settle();
    const by = (id: string) => source.reports.filter((r) => 'job' in r && r.job.id === id).map((r) => r.kind);
    expect(by('job-1')).toEqual(['claimed', 'finished']);
    expect(by('job-2')).toEqual(['claimed', 'failed']);
    expect(by('job-3')).toEqual(['claimed', 'cancelled']);
    expect(world.jobs.get('job-3')!.sourceState!.sync!.cancelReason).toBe('cancelled in UI');
  });

  it('ignores events for jobs of another source', async () => {
    const { world, source, sync } = await setup();
    source.items = [item('k1')];
    await sync.syncNow();
    world.jobs.set('x', { ...world.jobs.get('job-1')!, id: 'x', source: { source: 'other', kind: 'o', key: 'z' }, status: 'finished' });
    world.emit('job.finished', 'x');
    await settle();
    expect(kinds(source)).toEqual(['claimed']);
  });

  it('serializes reports for one job', async () => {
    const { world, source, sync } = await setup();
    let release!: () => void;
    source.gate = new Promise<void>((r) => { release = r; });
    source.items = [item('k1')];
    const first = sync.syncNow(); // the claim report waits at the gate
    await settle();
    world.patchJob('job-1', { status: 'finished' });
    world.emit('job.finished', 'job-1');
    await settle();
    expect(source.inFlight).toBe(1);
    release();
    await first;
    await settle();
    expect(source.maxInFlight).toBe(1);
    expect(kinds(source)).toEqual(['claimed', 'finished']);
  });
});

describe('signals', () => {
  it('calls host.cancel and records the reason before the cancelled report', async () => {
    const { world, source, sync } = await setup();
    source.items = [item('k1')];
    await sync.syncNow();
    source.signals = [{ kind: 'cancel', jobId: 'job-1', reason: 'issue closed' }];
    await sync.syncNow();
    expect(world.calls.cancel).toEqual([['job-1', 'issue closed']]);
    const cancelled = source.reports.find((r) => r.kind === 'cancelled')!;
    expect('job' in cancelled && cancelled.job.sourceState!.sync!.cancelReason).toBe('issue closed');
  });
});

describe('status and lifecycle', () => {
  it('goes ok → error → ok and isolates a throwing source', async () => {
    const good = createFakeSource('good');
    const bad = createFakeSource('bad');
    const { sync } = await setup({ sources: [good, bad] });
    const seen: string[] = [];
    sync.onStatus((s) => seen.push(`${s.name}:${s.state}`));
    bad.discoverError = new Error('network down');
    await sync.syncNow();
    const by = (n: string) => sync.statuses().find((s) => s.name === n)!;
    expect(by('good').state).toBe('ok');
    expect(by('bad')).toMatchObject({ state: 'error', lastError: 'network down' });
    expect(by('bad').nextSyncAt).toBeTruthy();
    bad.discoverError = undefined;
    await sync.syncNow('bad');
    expect(by('bad')).toMatchObject({ state: 'ok' });
    expect(by('bad').lastError).toBeUndefined();
    expect(seen).toContain('bad:error');
    expect(seen.at(-1)).toBe('bad:ok');
  });

  it('starts as "starting" with describe() detail', async () => {
    const { sync } = await setup({ start: false });
    expect(sync.statuses()[0]).toMatchObject({ name: 'fake', kind: 'fake', state: 'starting', detail: { label: 'x' } });
  });

  it('never overlaps two syncs of one source', async () => {
    const { source, sync } = await setup();
    let active = 0; let max = 0;
    const orig = source.discover;
    source.discover = async () => { active++; max = Math.max(max, active); await settle(2); const r = await orig(); active--; return r; };
    await Promise.all([sync.syncNow(), sync.syncNow()]);
    expect(max).toBe(1);
  });

  it('polls on its timer and stop() halts it and awaits in-flight work', async () => {
    const world = createWorld();
    const source = createFakeSource();
    sync = createSourceSync({ sources: [source], host: world.host, clock: world.clock, pollMs: () => 10 });
    sync.start();
    await new Promise((r) => setTimeout(r, 60));
    expect(source.discovers).toBeGreaterThan(1);
    let release!: () => void;
    source.gate = undefined;
    const slow = source.discover;
    source.discover = async () => { await new Promise<void>((r) => { release = r; }); return slow(); };
    await new Promise((r) => setTimeout(r, 30));
    let stopped = false;
    const p = sync.stop().then(() => { stopped = true; });
    await settle();
    expect(stopped).toBe(false);
    release();
    await p;
    const n = source.discovers;
    await new Promise((r) => setTimeout(r, 40));
    expect(source.discovers).toBe(n);
  });
});
