// Issue #10 through the real composition root: a machine named in plugins.yaml
// `attachedMachines:` is a machine the decider assigns jobs to, and the executor is told it is
// running there (design.md "Attached machines"). The probe is the seam: no ssh in this test.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AttachedMachine } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, writePluginsYaml, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
  cleanup = undefined;
});

/** plugins.yaml with a `where` executor (reports ctx.machine) and one attached machine `laptop`. */
function configure(laptopLanes: number): string {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const dir = dirname(db.dbPath);
  const plugin = join(dir, 'plugins', 'where');
  mkdirSync(plugin, { recursive: true, mode: 0o700 });
  writeFileSync(join(plugin, 'index.js'), [
    "export default { id: 'where', role: 'executor', describe: 'says where it ran',",
    "  async detect() { return { status: 'available' }; },",
    "  create() { return { name: 'where', idempotent: true, validate() { return null; },",
    "    async run(ctx) { return { kind: 'finished', result: { machine: ctx.machine.id, ssh: ctx.machine.ssh ?? null } }; } }; } };",
  ].join('\n'), { mode: 0o600 });
  writePluginsYaml(db.dbPath, [
    'version: 1',
    'executors: [ { name: test, plugin: test }, { name: where, plugin: where } ]',
    'attachedMachines:',
    `  - { name: laptop, label: arch-laptop, ssh: laptop, lanes: ${laptopLanes}, executors: [where] }`,
  ].join('\n'));
  return db.dbPath;
}

async function boot(dbPath: string, online: boolean): Promise<TestApp & { probed: AttachedMachine[] }> {
  const probed: AttachedMachine[] = [];
  const a = await startTestApp({ dbPath, seams: { machineProbe: (m) => { probed.push(m); return Promise.resolve({ online }); } } });
  apps.push(a);
  return Object.assign(a, { probed });
}

describe('attached machines', () => {
  it('an online attached machine with the most room runs the job; the executor is told the machine and its ssh target', async () => {
    const a = await boot(configure(8), true);
    await waitFor(async () => (await a.api('GET', '/api/machines')).body.machines.some((m: { id: string; online: boolean }) => m.id === 'laptop' && m.online));
    const job = await a.pull({}, { executor: 'where' });
    const done = await a.waitForStatus(job.id, 'finished');
    expect(done.result).toEqual({ machine: 'laptop', ssh: 'laptop' });
    expect(a.probed[0]).toMatchObject({ name: 'laptop', ssh: 'laptop', session: 'hopper', herdrBin: 'herdr' });
    const claimed = (await a.events('types=job.claimed&limit=100')).find((e) => e.jobId === job.id)!;
    expect(claimed.machineId).toBe('laptop');
  });

  it('/api/machines lists this machine and the attached one, with its ssh target', async () => {
    const a = await boot(configure(2), true);
    await waitFor(async () => (await a.api('GET', '/api/machines')).body.machines.some((m: { id: string; online: boolean }) => m.id === 'laptop' && m.online));
    const machines = (await a.api('GET', '/api/machines')).body.machines as { id: string; label: string; ssh?: string; executors: string[] }[];
    expect(machines.map((m) => m.id)).toEqual(['local', 'laptop']);
    expect(machines[1]).toMatchObject({ label: 'arch-laptop', ssh: 'laptop', executors: ['where'], maxLanes: 2 });
  });

  it('an offline attached machine gets nothing: the job runs here', async () => {
    const a = await boot(configure(8), false);
    const job = await a.pull({}, { executor: 'where' });
    const done = await a.waitForStatus(job.id, 'finished');
    expect(done.result).toEqual({ machine: 'local', ssh: null });
  });
});
