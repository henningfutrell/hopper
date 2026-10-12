// Issue #919: a machine removed from the plugins config is retired. A waiting job pinned to it — by hand, by a routing
// rule, or to resume there — would wait for it for good; the next scheduler pass fails it instead, with the reason
// `pinned machine <m> is retired`, so failure handling and Failures take it from there. Real HTTP server, store and
// engine; the probe is the seam.
import { afterEach, describe, expect, it } from 'vitest';
import type { MachinesConfig } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, writePlugins, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const FILE = {
  version: 1, executors: [{ name: 'test', plugin: 'test' }], jobSources: [],
  machines: [{ name: 'local', plugin: 'local' }, { name: 'desk', plugin: 'ssh', options: { ssh: 'desk', lanes: 1, executors: ['test'] } }],
};

async function start(): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  writePlugins(db.dbPath, FILE);
  t = await startTestApp({ dbPath: db.dbPath, seams: { machineProbe: async () => ({ online: true }) } });
  return { a: t, token: await t.login() };
}

const config = async (a: TestApp): Promise<MachinesConfig> => (await a.api('GET', '/api/machines/config')).body;
const machineIds = async (a: TestApp): Promise<string[]> => (await a.api('GET', '/api/machines')).body.machines.map((m: { id: string }) => m.id);

describe('a machine retired with jobs pinned to it (issue #919)', () => {
  it('fails each waiting job pinned to it, or resuming there, with the reason; a job pinned elsewhere waits on', async () => {
    const { a, token } = await start();
    const store = a.user().store;
    // An executor no machine runs: the jobs stay waiting instead of running and ending first.
    const pinned = store.jobs.create({ executor: 'nowhere', payload: {}, machineId: 'desk' }, 50);
    const resuming = store.jobs.create({ executor: 'nowhere', payload: {} }, 50);
    store.jobs.update(resuming.id, { pendingAnswer: 'yes', resumeOn: 'desk' });
    const elsewhere = store.jobs.create({ executor: 'nowhere', payload: {}, machineId: 'local' }, 50);
    await waitFor(() => store.jobs.get(pinned.id)?.status === 'held');

    const removed = await a.ui('/ui/api/plugins', { action: 'remove', role: 'machine-source', name: 'desk', version: (await config(a)).version }, { token });
    expect(removed.status).toBe(200);
    await waitFor(async () => !(await machineIds(a)).includes('desk'));

    await waitFor(() => store.jobs.get(pinned.id)?.status === 'failed' && store.jobs.get(resuming.id)?.status === 'failed');
    const reason = 'pinned machine desk is retired: it is no longer configured. Run the job again to place it on another machine';
    expect(store.jobs.get(pinned.id)?.error).toBe(reason);
    expect(store.jobs.get(resuming.id)?.error).toBe(reason);
    const failed = store.events.since(0, 100_000).filter((e) => e.type === 'job.failed' && e.jobId === pinned.id);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.data).toMatchObject({ error: reason });
    expect(store.jobs.get(elsewhere.id)?.status).toBe('held');
  });
});
