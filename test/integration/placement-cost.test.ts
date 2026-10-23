// Placement by expected cost (issue #688) through the real daemon, store and HTTP server: the job cost groups the hopper
// reads from its own runs give a waiting job its expected cost, and the job goes to the machine where that cost fits
// before memory pressure, not to the one the old order picks. The probe is the seam: no ssh here.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineSample, ResourceReading } from '../../src/domain/types.ts';
import type { MachineProbe } from '../../src/machines/index.ts';
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
const res = (availGib: number): ResourceReading => ({ cores: 8, cpuBusyFrac: 0.1, load: [1, 1, 1], memTotalBytes: 16 * GIB, memAvailableBytes: availGib * GIB });

/**
 * Two ssh machines with equal lanes: `desk` (12 GiB of 16 in use) and `laptop` (4 GiB in use). A `where` executor says
 * where it ran. Their memory floor is off, so no memory room (issue #2499) prefers `laptop`: only the expected cost does.
 */
async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const plugin = join(dirname(db.dbPath), 'plugins', 'where');
  mkdirSync(plugin, { recursive: true, mode: 0o700 });
  writeFileSync(join(plugin, 'index.js'), [
    "export default { id: 'where', role: 'executor', describe: 'says where it ran',",
    "  async detect() { return { status: 'available' }; },",
    "  create() { return { name: 'where', idempotent: true, validate() { return null; },",
    "    async run(ctx) { return { kind: 'finished', result: { machine: ctx.machine.id } }; } }; } };",
  ].join('\n'), { mode: 0o600 });
  writePlugins(db.dbPath, {
    version: 1,
    executors: [{ name: 'where', plugin: 'where' }],
    machines: ['desk', 'laptop'].map((name) => ({ name, plugin: 'ssh', options: { ssh: name, lanes: 2, executors: ['where'], memoryFloorGiB: 0 } })),
  });
  const probe = (name: string): MachineProbe => ({
    online: true, home: '/home/far', disk: { freeBytes: 50 * GIB, totalBytes: 100 * GIB, low: false }, resources: res(name === 'desk' ? 4 : 12),
  });
  const a = await startTestApp({ dbPath: db.dbPath, seams: { machineProbe: (m) => Promise.resolve(probe(m.name)) } });
  apps.push(a);
  await waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { online: boolean }[]).filter((m) => m.online).length === 2);
  return a;
}

/** Three finished code jobs on `laptop` a day ago, each 10 minutes at 3 GiB over its baseline of 4 GiB. */
function seed(a: TestApp): void {
  const store = a.user().store;
  const start = Date.now() - 24 * 60 * MIN;
  const samples: MachineSample[] = [];
  for (let i = 0; i < 50; i++) {
    const busy = i >= 20 ? 1 : 0;
    samples.push({
      machineId: 'laptop', at: new Date(start + i * MIN).toISOString(), cores: 8, cpuBusyFrac: 0.1,
      memTotalBytes: 16 * GIB, memAvailableBytes: (busy ? 9 : 12) * GIB, diskFreeBytes: 50 * GIB, diskTotalBytes: 100 * GIB, lanesBusy: busy, lanesMax: 2,
    });
  }
  store.machineHistory.record(samples);
  const iso = (min: number) => new Date(start + min * MIN).toISOString();
  store.tx(() => {
    for (let n = 0; n < 3; n++) {
      const done = store.jobs.create({ executor: 'where', payload: {}, machineId: 'nowhere' }, 50);
      store.jobs.update(done.id, { status: 'finished' });
      store.events.append({ type: 'job.claimed', jobId: done.id, machineId: 'laptop', laneId: 'laptop/lane-1', at: iso(20 + n * 10), data: { attempts: 1, effectivePriority: 50, reason: 'test' } });
      store.events.append({ type: 'job.finished', jobId: done.id, laneId: 'laptop/lane-1', at: iso(30 + n * 10), data: { result: 'ok' } });
    }
  });
}

const claimOf = async (a: TestApp, jobId: string) => (await a.events('types=job.claimed&limit=100')).find((e) => e.jobId === jobId)!;

describe('placement by expected cost', () => {
  it('with no job cost history, the job goes where the old order puts it', async () => {
    const a = await boot();
    const job = await a.pull({}, { executor: 'where' });
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ machine: 'desk' });
    expect(String((await claimOf(a, job.id)).data.reason)).not.toContain('expected cost');
  });

  it('a job whose expected memory peak would bring desk to memory pressure goes to laptop', async () => {
    const a = await boot();
    seed(a);
    expect((await a.api('GET', '/api/lanes/costs')).body.groups.kind).toEqual([expect.objectContaining({ key: 'code', jobs: 3 })]);
    const job = await a.pull({}, { executor: 'where' });
    expect((await a.waitForStatus(job.id, 'finished')).result).toEqual({ machine: 'laptop' });
    expect(String((await claimOf(a, job.id)).data.reason)).toContain('expected cost (kind code, 3 jobs): memory peak 3 GiB');
  });
});
