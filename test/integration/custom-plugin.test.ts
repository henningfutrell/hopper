// An author's custom plugin end to end (design.md "Settled in slice 6"): an example copied into the
// plugin dir of an ad-hoc daemon (real HTTP server, temp dirs) loads, shows in /api/plugins as a
// custom plugin, and runs once the plugins config selects it. Nothing leaves the machine.
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, writePlugins, type TestApp } from '../support/app.ts';

const EXAMPLES = join(import.meta.dirname, '..', '..', 'examples', 'plugins');
let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

describe('a custom plugin copied from examples/plugins', () => {
  it('loads from the plugin dir, appears in /api/plugins, and runs a job once the plugins config names it as an executor', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const dataDir = join(db.dbPath, '..');
    cpSync(join(EXAMPLES, 'executor', 'echo-executor'), join(dataDir, 'plugins', 'echo-executor'), { recursive: true });
    writePlugins(db.dbPath, { version: 1, executors: [{ name: 'test', plugin: 'test' }, { name: 'echo', plugin: 'echo-executor', options: { prefix: 'heard: ' } }], jobSources: [] });
    t = await startTestApp({ dbPath: db.dbPath });

    const report = (await t.api('GET', '/api/plugins')).body;
    expect(report.errors).toEqual([]);
    expect(report.plugins.find((p: { id: string }) => p.id === 'echo-executor')).toMatchObject({
      role: 'executor', builtin: false, path: join(dataDir, 'plugins', 'echo-executor', 'index.ts'), detection: { status: 'available' },
    });
    expect(report.executors.instances).toContainEqual(expect.objectContaining({ instance: expect.objectContaining({ name: 'echo' }), active: 'echo-executor' }));

    const job = await t.pull({}, { executor: 'echo', prompt: 'paint the shed' });
    const done = await t.waitForStatus(job.id, 'finished');
    expect(done.result).toMatchObject({ echoed: 'heard: paint the shed' });
  });
});
