// Job cost profiles (issue #688) through the real daemon, store and HTTP server: GET /api/lanes/costs answers, per
// finished job, what its runs cost on their machine — one lane's share of CPU, memory and disk net of the machine's
// baseline (its samples with no lane in use), peaks and averages —, its duration and the plan usage it burned, and the
// profiles grouped by repository, job cost kind and template. `hopper lanes costs` answers the same. The probe is the
// seam: no ssh here; the runs are the job's own events, the machine and usage samples the recorders' tables.
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { JobCosts, MachineSample, ResourceReading, UsageSample } from '../../src/domain/types.ts';
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
 * A day ago: 20 minutes with no lane in use (the baseline: 10% CPU, 4 GiB of memory, 50 GiB of disk used), then 30
 * minutes with one lane — 30% CPU, 6 GiB, 51 GiB, one minute at 7 GiB — while the job runs, and the machine's session
 * usage goes from 10% to 16%. The job finished; a second job that was parked has no profile.
 */
function seed(a: TestApp, waiting = 0): { start: number } {
  const store = a.user().store;
  const start = Date.now() - 24 * 60 * MIN;
  const samples: MachineSample[] = [];
  const usage: UsageSample[] = [];
  for (let i = 0; i < 50; i++) {
    const busy = i >= 20 ? 1 : 0;
    samples.push({
      machineId: 'laptop', at: new Date(start + i * MIN).toISOString(), cores: 8, cpuBusyFrac: busy ? 0.3 : 0.1,
      memTotalBytes: 16 * GIB, memAvailableBytes: ((busy ? (i === 30 ? 9 : 10) : 12) - (busy ? waiting : 0)) * GIB, diskFreeBytes: (busy ? 49 : 50) * GIB, diskTotalBytes: 100 * GIB,
      ...(busy && waiting ? { waitingMemBytes: waiting * GIB } : {}), lanesBusy: busy, lanesMax: 2,
    });
    if (busy) usage.push({ source: 'plan', machineId: 'laptop', window: 'session', used: 10 + (i - 20) * 0.2, limit: 100, unit: '%', at: new Date(start + i * MIN).toISOString() });
  }
  store.machineHistory.record(samples);
  store.usageHistory.record(usage);
  const pinned = { executor: 'test', payload: {}, machineId: 'nowhere' };
  const source = (n: number) => ({ source: 'github', kind: 'github', key: `https://github.com/o/r/issues/${n}`, repo: 'o/r', number: n });
  const iso = (min: number) => new Date(start + min * MIN).toISOString();
  store.tx(() => {
    const done = store.jobs.create(pinned, 50, source(1));
    store.jobs.update(done.id, { status: 'finished' });
    store.events.append({ type: 'job.claimed', jobId: done.id, machineId: 'laptop', laneId: 'laptop:1', at: iso(20), data: { attempts: 1, effectivePriority: 50, reason: 'test' } });
    store.events.append({ type: 'job.finished', jobId: done.id, laneId: 'laptop:1', at: iso(50), data: { result: 'ok' } });
    const parked = store.jobs.create({ ...pinned, research: true }, 50, source(2));
    store.jobs.update(parked.id, { status: 'parked' });
    store.events.append({ type: 'job.claimed', jobId: parked.id, machineId: 'laptop', laneId: 'laptop:2', at: iso(20), data: { attempts: 1, effectivePriority: 50, reason: 'test' } });
    store.events.append({ type: 'job.parked', jobId: parked.id, at: iso(30), data: { from: 'running', machineId: 'laptop' } });
  });
  return { start };
}

describe('job cost profiles', () => {
  it('per finished job: one lane\'s share net of the baseline, the duration and the usage burned; grouped', async () => {
    const a = await boot();
    expect((await a.api<JobCosts>('GET', '/api/lanes/costs')).body).toMatchObject({ windowDays: 30, jobs: [], groups: { repo: [], kind: [], template: [] } });
    const { start } = seed(a);
    const r = await a.api<JobCosts>('GET', '/api/lanes/costs');
    expect(r.status).toBe(200);
    expect(r.body.jobs).toHaveLength(1);
    const [p] = r.body.jobs;
    expect(p).toMatchObject({
      repo: 'o/r', kind: 'code', machineId: 'laptop', outcome: 'finished', finishedAt: new Date(start + 50 * MIN).toISOString(),
      durationMs: 30 * MIN, runs: 1, samples: 30,
    });
    expect(p).not.toHaveProperty('template');
    expect(p!.cpu!.avg).toBeCloseTo(0.2);
    expect(p!.cpu!.peak).toBeCloseTo(0.2);
    expect(p!.memoryBytes!.avg / GIB).toBeCloseTo(2 + 1 / 30);
    expect(p!.memoryBytes!.peak / GIB).toBeCloseTo(3);
    expect(p!.diskBytes!.peak / GIB).toBeCloseTo(1);
    expect(p!.usage.session).toBeCloseTo(0.058);
    expect(r.body.groups.repo).toEqual([expect.objectContaining({ key: 'o/r', jobs: 1, failed: 0, durationMs: 30 * MIN })]);
    expect(r.body.groups.kind.map((g) => g.key)).toEqual(['code']);
    expect(r.body.groups.template).toEqual([]);
  });

  // Issue #2499: a job on its own wait holds no lane, but its scope keeps memory. That memory is not the running job's.
  it('memory held by jobs with no lane is not counted as the running job\'s', async () => {
    const a = await boot();
    seed(a, 1.5);
    const [p] = (await a.api<JobCosts>('GET', '/api/lanes/costs')).body.jobs;
    expect(p!.memoryBytes!.avg / GIB).toBeCloseTo(2 + 1 / 30);
    expect(p!.memoryBytes!.peak / GIB).toBeCloseTo(3);
  });

  it('`hopper lanes costs` answers the same as the route', async () => {
    const a = await boot();
    seed(a);
    const out: string[] = [];
    const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: () => {} };
    expect(await runCli(['lanes', 'costs', '--url', a.url], io)).toBe(0);
    const cli = JSON.parse(out.join('')) as JobCosts;
    expect(cli.jobs.map((j) => j.jobId)).toEqual((await a.api<JobCosts>('GET', '/api/lanes/costs')).body.jobs.map((j) => j.jobId));
    expect(cli.groups.repo[0]).toMatchObject({ key: 'o/r', jobs: 1 });
  });
});
