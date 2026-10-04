// Issue #18: the queue sorter through the real daemon. The engine asks the live queue-sorter
// instance for an order each Decision; a plugins.yaml change swaps it between Decisions (the
// file is checked every 5 s in production); a sorter that throws gives priority's order and shows
// as a fallback in /api/plugins.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, TEST_PLUGINS, writePluginsYaml, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function boot(plugins: Record<string, unknown> = {}, before?: (dataDir: string) => void): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  before?.(join(db.dbPath, '..'));
  t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(1), ...plugins } });
  return t;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One busy lane, then an older low-priority job and a newer high-priority one waiting behind it. */
async function queueBehindBlocker(a: TestApp): Promise<{ blocker: Job; older: Job; newer: Job }> {
  const blocker = await a.pull({ op: 'sleep', ms: 30000 });
  await a.waitForStatus(blocker.id, 'running');
  const older = await a.pull({ op: 'echo' }, { priority: 10 });
  await pause(5);
  const newer = await a.pull({ op: 'echo' }, { priority: 90 });
  return { blocker, older, newer };
}

/** Free the lane and return which of the two was claimed first. */
async function firstClaimed(a: TestApp, blocker: Job, ids: string[]): Promise<string> {
  const token = await a.login();
  expect((await a.ui(`/ui/api/jobs/${blocker.id}/cancel`, {}, { token })).status).toBe(200);
  for (const id of ids) await a.waitForStatus(id, 'finished');
  const claims = (await a.events('types=job.claimed&limit=1000')).map((e) => e.jobId).filter((id) => ids.includes(id!));
  return claims[0]!;
}

describe('the queue sorter in the engine', () => {
  it('default (no queueSorter section): priority — the higher priority starts first', async () => {
    const a = await boot();
    expect((await a.api('GET', '/api/plugins')).body.queueSorter).toMatchObject({ instance: { name: 'priority' }, active: 'priority', fallback: false });
    const { blocker, older, newer } = await queueBehindBlocker(a);
    expect((await a.api('GET', '/api/queue')).body.waiting.map((j: Job) => j.id)).toEqual([newer.id, older.id]);
    expect(await firstClaimed(a, blocker, [older.id, newer.id])).toBe(newer.id);
  });

  it('a plugins.yaml change swaps the sorter within 5 s: oldest-first starts the older job first', async () => {
    const a = await boot();
    const { blocker, older, newer } = await queueBehindBlocker(a);
    writePluginsYaml(a.dbPath, { ...TEST_PLUGINS, machines: lanes(1), queueSorter: { name: 'fifo', plugin: 'oldest-first' } });
    await waitFor(async () => (await a.api('GET', '/api/plugins')).body.queueSorter.active === 'oldest-first', { timeoutMs: 5000, what: 'the sorter swap' });
    expect((await a.api('GET', '/api/queue')).body.waiting.map((j: Job) => j.id)).toEqual([older.id, newer.id]);
    expect(await firstClaimed(a, blocker, [older.id, newer.id])).toBe(older.id);
    const decisions = (await a.api('GET', '/api/decisions?limit=50')).body.decisions;
    expect(decisions.some((d: { inputs: { queueOrder?: { sorter: string } } }) => d.inputs.queueOrder?.sorter === 'fifo')).toBe(true);
  });

  it('the UI selects a queue sorter (POST /ui/api/plugins select)', async () => {
    const a = await boot();
    const token = await a.login();
    const version = (await a.api('GET', '/api/plugins')).body.config.version;
    const r = await a.ui<{ queueSorter: { active: string } }>('/ui/api/plugins', { action: 'select', role: 'queue-sorter', plugin: 'newest-first', version }, { token });
    expect(r.status).toBe(200);
    expect(r.body.queueSorter.active).toBe('newest-first');
  });

  it('a sorter that throws: priority\'s order, fallback in /api/plugins with the reason; jobs still run', async () => {
    const a = await boot({ queueSorter: { name: 'broken', plugin: 'throwing-sorter' } }, (dataDir) => {
      mkdirSync(join(dataDir, 'plugins', 'throwing-sorter'), { recursive: true, mode: 0o700 });
      writeFileSync(join(dataDir, 'plugins', 'throwing-sorter', 'index.js'), `export default {
  id: 'throwing-sorter', role: 'queue-sorter', describe: 'throws',
  async detect() { return { status: 'available' }; },
  create() { return { name: 'throwing-sorter', sort() { throw new Error('sorter broke'); } }; },
};
`);
    });
    const { blocker, older, newer } = await queueBehindBlocker(a);
    await waitFor(async () => (await a.api('GET', '/api/plugins')).body.queueSorter.fallback === true, { what: 'the fallback to show' });
    expect((await a.api('GET', '/api/plugins')).body.queueSorter).toMatchObject({ active: 'throwing-sorter', fallback: true, reason: expect.stringContaining('sorter broke') });
    expect(await firstClaimed(a, blocker, [older.id, newer.id])).toBe(newer.id);
  });
});
