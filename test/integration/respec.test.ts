// Issue #375: a job that has not started takes the config as it is now. Each sync works its spec's
// source- and routing-derived parts out again — executor, model, work tree, default work tree, machine
// pin, routing rule — as it already did its priority, and records `job.respecified` when they change.
// A part changed on the job by hand since keeps the hand value. A started job keeps what it ran with.
import { afterEach, describe, expect, it } from 'vitest';
import type { Job, RoutingReport } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, TEST_PLUGINS, writePlugins, type TestApp } from '../support/app.ts';
import { manualItem } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const FILE = { ...TEST_PLUGINS, machines: lanes(2) };

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  writePlugins(db.dbPath, FILE);
  t = await startTestApp({ dbPath: db.dbPath });
  return t;
}

async function setRouting(a: TestApp, routing: unknown[]) {
  writePlugins(a.dbPath, { ...FILE, routing });
  await waitFor(async () => (await a.api<RoutingReport>('GET', '/api/routing')).body.rules.length === routing.length, { what: 'the rules to reload' });
}

/** The item offered again, as its source reads it now. */
const offer = (a: TestApp, job: Job, over: Parameters<typeof manualItem>[0]) =>
  a.source.add(manualItem({ key: job.source!.key, prompt: '{"op":"echo"}', ...over }));

describe('a waiting job takes the config as it is now', () => {
  it('a routing rule added after intake pins the waiting job, sets its work tree and records the rule (job.respecified)', async () => {
    const a = await boot();
    a.setUsage(100);
    const job = await a.pull({ op: 'echo' }, { key: 'win-1', title: 'windows only' });
    expect(job.spec.machineId).toBeUndefined();
    await setRouting(a, [{ name: 'windows', match: { title: 'windows' }, set: { machine: 'local', workTree: '~/code/win' } }]);
    offer(a, job, { title: 'windows only' });
    await a.sync();
    const now = await a.job(job.id);
    expect(now.spec).toMatchObject({ machineId: 'local', payload: { cwd: '~/code/win' }, routedBy: { rule: 'windows', set: { machine: 'local', workTree: '~/code/win' } } });
    const ev = (await a.events('types=job.respecified')).filter((e) => e.jobId === job.id);
    expect(ev.map((e) => e.data)).toEqual([{
      from: { executor: 'scripted', cwd: '/tmp' },
      to: { executor: 'scripted', cwd: '~/code/win', machineId: 'local', rule: 'windows' },
    }]);
    await a.sync();
    expect((await a.events('types=job.respecified')).filter((e) => e.jobId === job.id)).toHaveLength(1);
  });

  it('a source\'s new model and work tree reach a waiting job; a rule\'s priority does too', async () => {
    const a = await boot();
    a.setUsage(100);
    const job = await a.pull({ op: 'echo' }, { key: 'model-1', cwd: '/old/tree' });
    expect(job.spec.payload).not.toHaveProperty('model');
    offer(a, job, { cwd: '/new/tree', model: 'claude-opus-5-5' });
    await setRouting(a, [{ name: 'boost', match: {}, set: { priority: 80 } }]);
    await a.sync();
    const now = await a.job(job.id);
    expect(now.spec.payload).toMatchObject({ cwd: '/new/tree', model: 'claude-opus-5-5' });
    expect(now.priority).toBe(80);
  });

  it('a part changed on the job by hand keeps the hand value; the parts left alone follow the config', async () => {
    const a = await boot();
    a.setUsage(100);
    const job = await a.pull({ op: 'echo' }, { key: 'hand-1', model: 'claude-sonnet-5-5' });
    // An operator's edit of the stored job, as the reported workaround did in the database.
    const store = a.user().store;
    store.jobs.respecify(job.id, { ...job.spec, payload: { ...job.spec.payload, model: 'claude-fable-5-1' } });
    offer(a, job, { model: 'claude-opus-5-5', cwd: '/new/tree' });
    await a.sync();
    expect((await a.job(job.id)).spec.payload).toMatchObject({ model: 'claude-fable-5-1', cwd: '/new/tree' });
  });

  it('a started job keeps the spec it started with', async () => {
    const a = await boot();
    const job = await a.pull({ op: 'sleep', ms: 5000 }, { key: 'run-1' });
    await a.waitForStatus(job.id, 'running');
    offer(a, job, { prompt: '{"op":"sleep","ms":5000}', model: 'claude-opus-5-5', cwd: '/new/tree' });
    await a.sync();
    expect((await a.job(job.id)).spec).toEqual(job.spec);
    expect((await a.events('types=job.respecified')).filter((e) => e.jobId === job.id)).toEqual([]);
  });
});
