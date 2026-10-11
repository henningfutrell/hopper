// Lane tuning (issue #688) through the real daemon, store and HTTP server: GET /api/lanes/plan answers each machine's
// lane recommendation from its machine samples and the usage it burns, next to its configured lanes; an admin sets
// auto-tune and the bounds (POST /ui/api/lanes/tuning, one lanes.tuning_changed); in shadow a recommendation that
// changes is recorded as lanes.recommended after the resource recorder keeps new samples, once per change; the CLI's
// `hopper lanes plan` answers the same plan. In active mode (the machine's `mode` setting) a recommendation is applied
// within the bounds — the machine's lanes in use, one lanes.applied with its reason —, an admin undoes the last change
// (POST /ui/api/lanes/undo, one lanes.undone) and the undone lanes are not applied again; back to shadow, the configured
// lanes. The probe is the seam: no ssh here.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { LaneTuningPlan, MachineSample, ResourceReading } from '../../src/domain/types.ts';
import type { MachineProbe } from '../../src/machines/index.ts';
import { databaseUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, writePlugins, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const GIB = 1024 ** 3;
const MIN = 60_000;
const RES: ResourceReading = { cores: 8, cpuBusyFrac: 0.1, load: [1, 1, 1], memTotalBytes: 16 * GIB, memAvailableBytes: 12 * GIB };

/** One attached machine `laptop` with 2 lanes, online, its probe reading RES. */
async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  writePlugins(db.dbPath, {
    version: 1,
    executors: [{ name: 'test', plugin: 'test' }],
    machines: [{ name: 'laptop', plugin: 'ssh', options: { label: 'arch-laptop', ssh: 'laptop', lanes: 2, executors: ['test'] } }],
  });
  const probe: MachineProbe = { online: true, home: '/home/far', disk: { freeBytes: 50 * GIB, totalBytes: 100 * GIB, low: false }, resources: RES };
  const a = await startTestApp({ dbPath: db.dbPath, seams: { machineProbe: () => Promise.resolve(probe) } });
  apps.push(a);
  await waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[]).find((m) => m.id === 'laptop' && m.online));
  return a;
}

/**
 * Twenty minutes each at 0, 1 and 2 lanes in use, in the last day: a lane costs 2 GiB and 10% CPU, no pressure. Room
 * past 2 lanes for 2 more (memory to 85% of 16 GiB).
 */
function seed(a: TestApp, minutes = 20): void {
  const start = Date.now() - 24 * 60 * MIN;
  const samples: MachineSample[] = [];
  for (const k of [0, 1, 2]) {
    for (let i = 0; i < minutes; i++) {
      samples.push({
        machineId: 'laptop', at: new Date(start + (k * minutes + i) * MIN).toISOString(), cores: 8, cpuBusyFrac: 0.1 + k * 0.1,
        memTotalBytes: 16 * GIB, memAvailableBytes: (12 - 2 * k) * GIB, diskFreeBytes: 50 * GIB, diskTotalBytes: 100 * GIB, lanesBusy: k, lanesMax: 2,
      });
    }
  }
  a.user().store.machineHistory.record(samples);
}

const plan = async (a: TestApp) => {
  const r = await a.api<LaneTuningPlan>('GET', '/api/lanes/plan');
  expect(r.status).toBe(200);
  return r.body;
};
const laptop = async (a: TestApp) => (await plan(a)).machines.find((m) => m.machineId === 'laptop')!;

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: () => {} };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join('') };
}

describe('lane tuning', () => {
  it('recommends from the machine samples, next to the configured lanes, in shadow', async () => {
    const a = await boot();
    expect(await laptop(a)).toMatchObject({ configured: 2, lanes: 2, confidence: 0, reason: expect.stringMatching(/^not enough history/) });
    seed(a);
    const p = await plan(a);
    expect(p).toMatchObject({ windowDays: 7, changes: [] });
    expect(p.machines.find((m) => m.machineId === 'laptop')).toEqual({
      machineId: 'laptop', label: 'arch-laptop', online: true, configured: 2, inUse: 2, lanes: 4, headroom: 4, confidence: 0.33, usedFrac: 0, usage: 'free',
      tuning: { autoTune: true, minLanes: 1, maxLanes: 8, mode: 'shadow' },
      reason: 'no resource pressure up to 2 lanes in use; a lane uses about 2.0 GiB of memory and 10% CPU: room for 2 more',
    });
  });

  it('adds no lanes near the soft limit', async () => {
    const a = await boot();
    seed(a);
    a.setUsage(65);
    expect(await laptop(a)).toMatchObject({ lanes: 2, headroom: 4, usage: 'near', usedFrac: 0.65 });
  });

  it('an admin sets auto-tune and the bounds; refused when the bounds cross or the machine is unknown', async () => {
    const a = await boot();
    seed(a);
    const admin = await a.login();
    const r = await a.ui<LaneTuningPlan>('/ui/api/lanes/tuning', { machineId: 'laptop', maxLanes: 3 }, { token: admin });
    expect(r.status).toBe(200);
    expect(r.body.machines.find((m) => m.machineId === 'laptop')).toMatchObject({ lanes: 3, tuning: { autoTune: true, minLanes: 1, maxLanes: 3, mode: 'shadow' } });
    expect((await a.events('types=lanes.tuning_changed')).map((e) => e.data)).toEqual([
      { machineId: 'laptop', from: { autoTune: true, minLanes: 1, maxLanes: 8, mode: 'shadow' }, to: { autoTune: true, minLanes: 1, maxLanes: 3, mode: 'shadow' }, by: expect.any(String) },
    ]);
    expect((await a.ui('/ui/api/lanes/tuning', { machineId: 'laptop', minLanes: 4 }, { token: admin })).status).toBe(400);
    expect((await a.ui('/ui/api/lanes/tuning', { machineId: 'laptop' }, { token: admin })).status).toBe(400);
    expect((await a.ui('/ui/api/lanes/tuning', { machineId: 'nowhere', maxLanes: 3 }, { token: admin })).status).toBe(404);
    expect((await a.ui('/ui/api/lanes/tuning', { machineId: 'laptop', mode: 'auto' }, { token: admin })).status).toBe(400);

    await a.ui('/ui/api/lanes/tuning', { machineId: 'laptop', autoTune: false }, { token: admin });
    expect(await laptop(a)).toMatchObject({ lanes: 2, confidence: 0, reason: 'auto-tune is off for this machine', tuning: { autoTune: false, maxLanes: 3 } });
    expect(await a.events('types=lanes.tuning_changed')).toHaveLength(2);
  });

  it('records a recommendation once per change, after the resource recorder keeps new samples', async () => {
    const a = await boot();
    seed(a);
    expect(await a.user().machineHistory.record()).toBe(1);
    const [first] = await waitFor(async () => { const e = await a.events('types=lanes.recommended'); return e.length ? e : undefined; });
    expect(first!.data).toMatchObject({ machineId: 'laptop', lanes: 4, configured: 2, headroom: 4, usage: 'free', mode: 'shadow' });
    expect(await a.user().engine.laneTuning.record()).toBe(0);

    const admin = await a.login();
    await a.ui('/ui/api/lanes/tuning', { machineId: 'laptop', maxLanes: 3 }, { token: admin });
    expect(await a.user().engine.laneTuning.record()).toBe(1);
    expect((await a.events('types=lanes.recommended')).map((e) => (e.data as { lanes: number }).lanes).sort()).toEqual([3, 4]);
  });

  it('hopper lanes plan answers the plan; hopper lanes tune sets a machine\'s settings', async () => {
    const a = await boot();
    seed(a);
    const out = await hopper(a, ['lanes', 'plan']);
    expect(out.code).toBe(0);
    const cli = JSON.parse(out.out) as LaneTuningPlan;
    expect(cli.machines).toEqual((await plan(a)).machines);

    expect((await hopper(a, ['lanes', 'tune', 'laptop', '--auto', 'off', '--max', '3'])).code).toBe(0);
    expect((await laptop(a)).tuning).toEqual({ autoTune: false, minLanes: 1, maxLanes: 3, mode: 'shadow' });
    expect((await hopper(a, ['lanes', 'tune', 'laptop', '--mode', 'active'])).code).toBe(0);
    expect((await laptop(a)).tuning.mode).toBe('active');
    expect((await hopper(a, ['lanes', 'tune', 'laptop'])).code).toBe(2);
    expect((await hopper(a, ['lanes', 'tune', 'laptop', '--auto', 'maybe'])).code).toBe(2);
    expect((await hopper(a, ['lanes', 'tune', 'laptop', '--mode', 'auto'])).code).toBe(2);
    // Nothing applied yet: nothing to undo.
    expect((await hopper(a, ['lanes', 'undo', 'laptop'])).code).not.toBe(0);
  });
});

/** The laptop as the engine lists it to the decider and the Machines view. */
const machineOf = async (a: TestApp) => ((await a.api('GET', '/api/machines')).body.machines as { id: string; maxLanes: number; configuredLanes?: number }[])
  .find((m) => m.id === 'laptop')!;

describe('lane tuning, active mode', () => {
  it('applies a recommendation within the bounds: the lanes in use, one lanes.applied with its reason', async () => {
    const a = await boot();
    seed(a, 40);
    const admin = await a.login();
    // Shadow: recorded, not applied.
    expect(await a.user().engine.laneTuning.record()).toBe(1);
    expect(await a.events('types=lanes.applied')).toEqual([]);
    expect(await machineOf(a)).toMatchObject({ maxLanes: 2 });

    const r = await a.ui<LaneTuningPlan>('/ui/api/lanes/tuning', { machineId: 'laptop', mode: 'active' }, { token: admin });
    expect(r.status).toBe(200);
    expect(await a.user().engine.laneTuning.record()).toBe(1);
    const [applied] = await a.events('types=lanes.applied');
    expect(applied!.data).toEqual({
      machineId: 'laptop', from: 2, to: 4, configured: 2, confidence: 0.67,
      reason: 'no resource pressure up to 2 lanes in use; a lane uses about 2.0 GiB of memory and 10% CPU: room for 2 more',
    });
    expect(await machineOf(a)).toMatchObject({ maxLanes: 4, configuredLanes: 2 });
    const usage = await a.api('GET', '/api/usage');
    expect((usage.body.machines as { machineId: string; maxLanes: number; cap: number }[]).find((m) => m.machineId === 'laptop')).toMatchObject({ maxLanes: 4, cap: 4 });
    const p = await plan(a);
    expect(p.machines.find((m) => m.machineId === 'laptop')).toMatchObject({ configured: 2, inUse: 4, lanes: 4, undo: { to: 2 } });
    expect(p.changes).toEqual([expect.objectContaining({ machineId: 'laptop', kind: 'applied', from: 2, to: 4, reason: expect.stringMatching(/^no resource pressure/) })]);
    // Applied once: the next record changes nothing.
    expect(await a.user().engine.laneTuning.record()).toBe(0);

    // A lower most-lanes bound holds at once.
    await a.ui('/ui/api/lanes/tuning', { machineId: 'laptop', maxLanes: 3 }, { token: admin });
    expect(await machineOf(a)).toMatchObject({ maxLanes: 3 });
  });

  it('applies nothing on too little history', async () => {
    const a = await boot();
    seed(a);
    const admin = await a.login();
    await a.ui('/ui/api/lanes/tuning', { machineId: 'laptop', mode: 'active' }, { token: admin });
    await a.user().engine.laneTuning.record();
    expect(await a.events('types=lanes.applied')).toEqual([]);
    expect(await machineOf(a)).toMatchObject({ maxLanes: 2 });
  });

  it('an admin undoes the last change; the undone lanes are not applied again; shadow again uses the configured lanes', async () => {
    const a = await boot();
    seed(a, 40);
    const admin = await a.login();
    await a.ui('/ui/api/lanes/tuning', { machineId: 'laptop', mode: 'active' }, { token: admin });
    await a.user().engine.laneTuning.record();
    expect(await machineOf(a)).toMatchObject({ maxLanes: 4 });

    const u = await a.ui<LaneTuningPlan>('/ui/api/lanes/undo', { machineId: 'laptop' }, { token: admin });
    expect(u.status).toBe(200);
    expect(u.body.machines.find((m) => m.machineId === 'laptop')).toMatchObject({ inUse: 2, lanes: 4 });
    expect(u.body.machines.find((m) => m.machineId === 'laptop')).not.toHaveProperty('undo');
    expect((await a.events('types=lanes.undone')).map((e) => e.data)).toEqual([{ machineId: 'laptop', from: 4, to: 2, by: expect.any(String) }]);
    expect(await machineOf(a)).toMatchObject({ maxLanes: 2 });
    expect(await a.user().engine.laneTuning.record()).toBe(0);
    expect(await a.events('types=lanes.applied')).toHaveLength(1);
    // Nothing left to undo.
    expect((await a.ui('/ui/api/lanes/undo', { machineId: 'laptop' }, { token: admin })).status).toBe(409);
    expect((await a.ui('/ui/api/lanes/undo', { machineId: 'nowhere' }, { token: admin })).status).toBe(404);

    // A new recommendation applies; back to shadow, the configured lanes.
    await a.ui('/ui/api/lanes/tuning', { machineId: 'laptop', maxLanes: 3 }, { token: admin });
    await a.user().engine.laneTuning.record();
    expect(await machineOf(a)).toMatchObject({ maxLanes: 3 });
    await a.ui('/ui/api/lanes/tuning', { machineId: 'laptop', mode: 'shadow' }, { token: admin });
    expect(await machineOf(a)).toMatchObject({ maxLanes: 2 });
    expect(await machineOf(a)).not.toHaveProperty('configuredLanes');
  });
});
