// Lane tuning (issue #688) through the real daemon, store and HTTP server: GET /api/lanes/plan answers each machine's
// lane recommendation from its machine samples and the usage it burns, next to its configured lanes; an admin sets
// auto-tune and the bounds (POST /ui/api/lanes/tuning, one lanes.tuning_changed); a recommendation that changes is
// recorded as lanes.recommended after the resource recorder keeps new samples, once per change; the CLI's `hopper lanes
// plan` answers the same plan. The hopper applies nothing by itself: an admin applies a recommendation — the machine's
// configured lanes, set as an edit of the machine sets them, one lanes.applied with its reason —, dismisses it until it
// moves (one lanes.dismissed), or undoes the last one applied (one lanes.undone). The probe is the seam: no ssh here.
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

/** One attached machine `laptop` with 2 lanes, online, its probe reading `resources`. */
async function boot(resources: ResourceReading = RES): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  writePlugins(db.dbPath, {
    version: 1,
    executors: [{ name: 'test', plugin: 'test' }],
    machines: [{ name: 'laptop', plugin: 'ssh', options: { label: 'arch-laptop', ssh: 'laptop', lanes: 2, executors: ['test'] } }],
  });
  const probe: MachineProbe = { online: true, home: '/home/far', disk: { freeBytes: 50 * GIB, totalBytes: 100 * GIB, low: false }, resources };
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

/**
 * Runs in the seeded minutes: four at 1 lane in use (minutes 20 to 39) that finished, and four at 2 lanes (minutes 40
 * to 59) that failed.
 */
function seedRuns(a: TestApp): void {
  const store = a.user().store;
  const start = Date.now() - 24 * 60 * MIN;
  const iso = (min: number) => new Date(start + min * MIN).toISOString();
  store.tx(() => {
    for (const [i, from, end] of [[0, 20, 'finished'], [1, 24, 'finished'], [2, 28, 'finished'], [3, 32, 'finished'], [4, 40, 'failed'], [5, 41, 'failed'], [6, 46, 'failed'], [7, 50, 'failed']] as const) {
      const job = store.jobs.create({ executor: 'test', payload: {}, machineId: 'nowhere' }, 50, { source: 'github', kind: 'github', key: `https://github.com/o/r/issues/${i}`, repo: 'o/r', number: i });
      store.jobs.update(job.id, { status: end });
      store.events.append({ type: 'job.claimed', jobId: job.id, machineId: 'laptop', laneId: 'laptop:1', at: iso(from), data: { attempts: 1, effectivePriority: 50, reason: 'test' } });
      store.events.append(end === 'finished'
        ? { type: 'job.finished', jobId: job.id, laneId: 'laptop:1', at: iso(from + 3), data: { result: 'ok' } }
        : { type: 'job.failed', jobId: job.id, laneId: 'laptop:1', at: iso(from + 3), data: { error: 'boom' } });
    }
  });
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
      machineId: 'laptop', label: 'arch-laptop', online: true, configured: 2, lanes: 4, headroom: 4, confidence: 0.33, usedFrac: 0, usage: 'free',
      tuning: { autoTune: true, minLanes: 1, maxLanes: 8 }, apply: { to: 4 },
      reason: 'no resource pressure up to 2 lanes in use; a lane uses about 2.0 GiB of memory and 10% CPU: room for 2 more',
    });
  });

  it('slow progress: runs at 2 lanes in use fail far more often than at 1, so 1 lane', async () => {
    const a = await boot();
    seed(a);
    seedRuns(a);
    expect(await laptop(a)).toMatchObject({
      configured: 2, lanes: 1, headroom: 1, confidence: 0.33, apply: { to: 1 },
      reason: 'slow progress at 2 lanes in use (4 of 4 runs failed; 0 of 4 at fewer lanes): 1 lane runs without it',
    });
  });

  it('recommends no more lanes than the machine\'s memory holds (issue #2499)', async () => {
    const a = await boot({ ...RES, memTotalBytes: 8 * GIB, memAvailableBytes: 6 * GIB });
    seed(a);
    expect(await laptop(a)).toMatchObject({
      configured: 2, lanes: 3, headroom: 4, apply: { to: 3 },
      reason: 'no resource pressure up to 2 lanes in use; a lane uses about 2.0 GiB of memory and 10% CPU: room for 2 more; '
        + 'its memory holds 3 jobs: 8 GiB less its floor of 1 GiB, at 2 GiB a job: no more than 3 lanes',
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
    expect(r.body.machines.find((m) => m.machineId === 'laptop')).toMatchObject({ lanes: 3, tuning: { autoTune: true, minLanes: 1, maxLanes: 3 } });
    expect((await a.events('types=lanes.tuning_changed')).map((e) => e.data)).toEqual([
      { machineId: 'laptop', from: { autoTune: true, minLanes: 1, maxLanes: 8 }, to: { autoTune: true, minLanes: 1, maxLanes: 3 }, by: expect.any(String) },
    ]);
    expect((await a.ui('/ui/api/lanes/tuning', { machineId: 'laptop', minLanes: 4 }, { token: admin })).status).toBe(400);
    expect((await a.ui('/ui/api/lanes/tuning', { machineId: 'laptop' }, { token: admin })).status).toBe(400);
    expect((await a.ui('/ui/api/lanes/tuning', { machineId: 'nowhere', maxLanes: 3 }, { token: admin })).status).toBe(404);
    expect((await a.ui('/ui/api/lanes/tuning', { machineId: 'laptop', mode: 'active' }, { token: admin })).status).toBe(400);

    await a.ui('/ui/api/lanes/tuning', { machineId: 'laptop', autoTune: false }, { token: admin });
    expect(await laptop(a)).toMatchObject({ lanes: 2, confidence: 0, reason: 'auto-tune is off for this machine', tuning: { autoTune: false, maxLanes: 3 } });
    expect(await a.events('types=lanes.tuning_changed')).toHaveLength(2);
  });

  it('records a recommendation once per change, after the resource recorder keeps new samples', async () => {
    const a = await boot();
    seed(a);
    expect(await a.user().machineHistory.record()).toBe(1);
    const [first] = await waitFor(async () => { const e = await a.events('types=lanes.recommended'); return e.length ? e : undefined; });
    expect(first!.data).toMatchObject({ machineId: 'laptop', lanes: 4, configured: 2, headroom: 4, usage: 'free' });
    expect(first!.data).not.toHaveProperty('mode');
    expect(await a.user().engine.laneTuning.record()).toBe(0);

    const admin = await a.login();
    await a.ui('/ui/api/lanes/tuning', { machineId: 'laptop', maxLanes: 3 }, { token: admin });
    expect(await a.user().engine.laneTuning.record()).toBe(1);
    expect((await a.events('types=lanes.recommended')).map((e) => (e.data as { lanes: number }).lanes).sort()).toEqual([3, 4]);
  });

  it('hopper lanes plan answers the plan; tune sets a machine\'s settings; apply, dismiss and undo act as the UI does', async () => {
    const a = await boot();
    seed(a);
    const out = await hopper(a, ['lanes', 'plan']);
    expect(out.code).toBe(0);
    const cli = JSON.parse(out.out) as LaneTuningPlan;
    expect(cli.machines).toEqual((await plan(a)).machines);

    expect((await hopper(a, ['lanes', 'tune', 'laptop', '--auto', 'off', '--max', '3'])).code).toBe(0);
    expect((await laptop(a)).tuning).toEqual({ autoTune: false, minLanes: 1, maxLanes: 3 });
    expect((await hopper(a, ['lanes', 'tune', 'laptop'])).code).toBe(2);
    expect((await hopper(a, ['lanes', 'tune', 'laptop', '--auto', 'maybe'])).code).toBe(2);
    expect((await hopper(a, ['lanes', 'tune', 'laptop', '--mode', 'active'])).code).not.toBe(0);
    // Auto-tune off: nothing to apply, nothing to undo.
    expect((await hopper(a, ['lanes', 'apply', 'laptop'])).code).not.toBe(0);
    expect((await hopper(a, ['lanes', 'undo', 'laptop'])).code).not.toBe(0);

    expect((await hopper(a, ['lanes', 'tune', 'laptop', '--auto', 'on'])).code).toBe(0);
    expect((await hopper(a, ['lanes', 'dismiss', 'laptop'])).code).toBe(0);
    expect((await laptop(a)).dismissed).toBeDefined();
    expect((await hopper(a, ['lanes', 'tune', 'laptop', '--max', '4'])).code).toBe(0);
    const applied = await hopper(a, ['lanes', 'apply', 'laptop']);
    expect(applied.code).toBe(0);
    expect((JSON.parse(applied.out) as LaneTuningPlan).machines.find((m) => m.machineId === 'laptop')).toMatchObject({ configured: 4, undo: { to: 2 } });
    expect((await hopper(a, ['lanes', 'undo', 'laptop'])).code).toBe(0);
    expect(await laptop(a)).toMatchObject({ configured: 2 });
  });
});

/** The laptop as the engine lists it to the decider and the Machines view. */
const machineOf = async (a: TestApp) => ((await a.api('GET', '/api/machines')).body.machines as { id: string; maxLanes: number }[]).find((m) => m.id === 'laptop')!;
/** The laptop's lanes in the plugins config: where an edit of the machine sets them. */
const configuredOf = async (a: TestApp) => ((await a.api('GET', '/api/plugins')).body.instances as { role: string; instance: { name: string; options?: { lanes?: number } } }[])
  .find((i) => i.role === 'machine-source' && i.instance.name === 'laptop')!.instance.options?.lanes;

describe('lane tuning: an admin applies, dismisses and undoes', () => {
  it('applies nothing by itself, however long the history', async () => {
    const a = await boot();
    seed(a, 40);
    expect(await a.user().engine.laneTuning.record()).toBe(1);
    expect(await a.user().engine.laneTuning.record()).toBe(0);
    expect(await a.events('types=lanes.applied')).toEqual([]);
    expect(await machineOf(a)).toMatchObject({ maxLanes: 2 });
    expect(await configuredOf(a)).toBe(2);
  });

  it('Apply sets the machine\'s configured lanes as an edit of the machine does, with one lanes.applied and its reason', async () => {
    const a = await boot();
    seed(a, 40);
    const admin = await a.login();
    const r = await a.ui<LaneTuningPlan>('/ui/api/lanes/apply', { machineId: 'laptop', lanes: 4 }, { token: admin });
    expect(r.status).toBe(200);
    expect(r.body.machines.find((m) => m.machineId === 'laptop')).toMatchObject({ configured: 4, lanes: 4, undo: { to: 2 } });
    expect(r.body.machines.find((m) => m.machineId === 'laptop')).not.toHaveProperty('apply');
    expect(await configuredOf(a)).toBe(4);
    await waitFor(async () => (await machineOf(a)).maxLanes === 4);
    const usage = await a.api('GET', '/api/usage');
    expect((usage.body.machines as { machineId: string; maxLanes: number; cap: number }[]).find((m) => m.machineId === 'laptop')).toMatchObject({ maxLanes: 4, cap: 4 });
    const [applied] = await a.events('types=lanes.applied');
    expect(applied!.data).toEqual({
      machineId: 'laptop', from: 2, to: 4, confidence: 0.67, by: expect.any(String),
      reason: 'no resource pressure up to 2 lanes in use; a lane uses about 2.0 GiB of memory and 10% CPU: room for 2 more',
    });
    expect(r.body.changes).toEqual([expect.objectContaining({ machineId: 'laptop', kind: 'applied', from: 2, to: 4, by: expect.any(String), reason: expect.stringMatching(/^no resource pressure/) })]);
  });

  it('Apply is refused when the recommendation moved, when there is none to apply, or for an unknown machine', async () => {
    const a = await boot();
    seed(a, 40);
    const admin = await a.login();
    const moved = await a.ui<{ error: string }>('/ui/api/lanes/apply', { machineId: 'laptop', lanes: 3 }, { token: admin });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toMatch(/now recommends 4 lanes/);
    expect((await a.ui('/ui/api/lanes/apply', { machineId: 'nowhere' }, { token: admin })).status).toBe(404);
    await a.ui('/ui/api/lanes/tuning', { machineId: 'laptop', autoTune: false }, { token: admin });
    expect((await a.ui('/ui/api/lanes/apply', { machineId: 'laptop' }, { token: admin })).status).toBe(409);
    expect(await configuredOf(a)).toBe(2);
    expect(await a.events('types=lanes.applied')).toEqual([]);
  });

  it('Dismiss hides a recommendation until it moves', async () => {
    const a = await boot();
    seed(a, 40);
    const admin = await a.login();
    const d = await a.ui<LaneTuningPlan>('/ui/api/lanes/dismiss', { machineId: 'laptop' }, { token: admin });
    expect(d.status).toBe(200);
    const r = d.body.machines.find((m) => m.machineId === 'laptop')!;
    expect(r).toMatchObject({ lanes: 4, configured: 2, dismissed: { by: expect.any(String) } });
    expect(r).not.toHaveProperty('apply');
    expect((await a.events('types=lanes.dismissed')).map((e) => e.data)).toEqual([
      { machineId: 'laptop', lanes: 4, configured: 2, reason: expect.stringMatching(/^no resource pressure/), by: expect.any(String) },
    ]);
    expect((await a.ui('/ui/api/lanes/dismiss', { machineId: 'laptop' }, { token: admin })).status).toBe(409);
    expect((await a.ui('/ui/api/lanes/apply', { machineId: 'laptop' }, { token: admin })).status).toBe(409);
    expect(await configuredOf(a)).toBe(2);
    // The recommendation moves: offered again.
    await a.ui('/ui/api/lanes/tuning', { machineId: 'laptop', maxLanes: 3 }, { token: admin });
    expect(await laptop(a)).toMatchObject({ lanes: 3, apply: { to: 3 } });
    expect(await laptop(a)).not.toHaveProperty('dismissed');
  });

  it('Undo sets the lanes back to before the last Apply; nothing to undo after a hand edit or a second undo', async () => {
    const a = await boot();
    seed(a, 40);
    const admin = await a.login();
    await a.ui('/ui/api/lanes/apply', { machineId: 'laptop' }, { token: admin });
    const u = await a.ui<LaneTuningPlan>('/ui/api/lanes/undo', { machineId: 'laptop' }, { token: admin });
    expect(u.status).toBe(200);
    expect(u.body.machines.find((m) => m.machineId === 'laptop')).toMatchObject({ configured: 2, lanes: 4, apply: { to: 4 } });
    expect(u.body.machines.find((m) => m.machineId === 'laptop')).not.toHaveProperty('undo');
    expect(await configuredOf(a)).toBe(2);
    expect((await a.events('types=lanes.undone')).map((e) => e.data)).toEqual([{ machineId: 'laptop', from: 4, to: 2, by: expect.any(String) }]);
    expect((await a.ui('/ui/api/lanes/undo', { machineId: 'laptop' }, { token: admin })).status).toBe(409);
    expect((await a.ui('/ui/api/lanes/undo', { machineId: 'nowhere' }, { token: admin })).status).toBe(404);

    // Applied, then edited by hand: the hand edit stands, nothing to undo.
    await a.ui('/ui/api/lanes/apply', { machineId: 'laptop' }, { token: admin });
    const config = (await a.api('GET', '/api/plugins')).body as { config: { version: string } };
    const edit = await a.ui('/ui/api/plugins', {
      action: 'options', role: 'machine-source', name: 'laptop', options: { label: 'arch-laptop', ssh: 'laptop', lanes: 3, executors: ['test'] }, version: config.config.version,
    }, { token: admin });
    expect(edit.status).toBe(200);
    expect(await laptop(a)).not.toHaveProperty('undo');
    expect((await a.ui('/ui/api/lanes/undo', { machineId: 'laptop' }, { token: admin })).status).toBe(409);
  });
});
