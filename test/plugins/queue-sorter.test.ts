// Issue #18: the queue-sorter role — live, exactly one instance, like the router. Built-ins
// `priority` (today's order, the default), `oldest-first`, `newest-first`. A sorter that cannot
// run, throws or returns garbage → `priority` answers, the fallback visible in /api/plugins.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueueEntry } from '../../src/domain/ports.ts';
import { ROLES, SELECTABLE_ROLES, type Job } from '../../src/domain/types.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { createPluginHost, type PluginHost } from '../../src/plugins/index.ts';
import newestFirst from '../../src/plugins/queue-sorter/newest-first/index.ts';
import oldestFirst from '../../src/plugins/queue-sorter/oldest-first/index.ts';
import priority from '../../src/plugins/queue-sorter/priority/index.ts';
import type { PluginDefinition } from '../../src/plugins/sdk.ts';
import { waitFor } from '../support/wait.ts';
import { PLUGINS } from '../../src/plugins/plugins-config.ts';
import { useTempConfig } from '../support/config.ts';
import { fakeKit, fixedClock, useTempDirs } from './support.ts';

const temp = useTempDirs();
const records = useTempConfig();
let host: PluginHost | undefined;
afterEach(() => { host?.stop(); host = undefined; });

const entry = (id: string, effectivePriority: number, createdAt: string): QueueEntry => ({
  job: { id, spec: { executor: 'test', payload: {} }, priority: effectivePriority, status: 'queued', approved: false, attempts: 0, createdAt, updatedAt: createdAt } as Job,
  effectivePriority,
});
const ENTRIES = [
  entry('b', 50, '2026-10-03T10:02:00.000Z'),
  entry('a', 50, '2026-10-03T10:02:00.000Z'),
  entry('old', 10, '2026-10-03T10:00:00.000Z'),
  entry('new', 90, '2026-10-03T10:05:00.000Z'),
];
const ctx = { clock: fixedClock, logger: { info() {}, warn() {} }, dataDir: '/tmp', userEnv: {}, scratchDir: '/tmp', instanceName: 'q', env: () => undefined };
const sorter = async (def: PluginDefinition<'queue-sorter'>) => def.create(ctx, {});

describe('the queue-sorter role', () => {
  it('is a role, selectable from the UI', () => {
    expect(ROLES).toContain('queue-sorter');
    expect(SELECTABLE_ROLES).toContain('queue-sorter');
    expect(BUILTIN_PLUGINS.filter((p) => p.role === 'queue-sorter').map((p) => p.id)).toEqual(['priority', 'oldest-first', 'newest-first']);
  });
});

describe('the built-in queue sorters', () => {
  it('priority: effective priority desc, createdAt asc, id — the decider\'s own rule', async () => {
    expect((await sorter(priority)).sort(ENTRIES)).toEqual(['new', 'a', 'b', 'old']);
  });
  it('oldest-first: createdAt asc, id', async () => {
    expect((await sorter(oldestFirst)).sort(ENTRIES)).toEqual(['old', 'a', 'b', 'new']);
  });
  it('newest-first: createdAt desc, id', async () => {
    expect((await sorter(newestFirst)).sort(ENTRIES)).toEqual(['new', 'a', 'b', 'old']);
  });
});

const throwing: PluginDefinition<'queue-sorter'> = {
  id: 'throwing-sorter', role: 'queue-sorter', describe: 'throws', async detect() { return { status: 'available' }; },
  create() { return { name: 'throwing-sorter', sort() { throw new Error('sort blew up'); } }; },
};
const garbage: PluginDefinition<'queue-sorter'> = {
  id: 'garbage-sorter', role: 'queue-sorter', describe: 'returns garbage', async detect() { return { status: 'available' }; },
  create() { return { name: 'garbage-sorter', sort: () => 'nope' as unknown as string[] }; },
};
const duplicating: PluginDefinition<'queue-sorter'> = {
  id: 'duplicating-sorter', role: 'queue-sorter', describe: 'names a job twice', async detect() { return { status: 'available' }; },
  create() { return { name: 'duplicating-sorter', sort: (e) => [e[0]!.job.id, e[0]!.job.id] }; },
};
const unavailable: PluginDefinition<'queue-sorter'> = {
  id: 'absent-sorter', role: 'queue-sorter', describe: 'not here', async detect() { return { status: 'unavailable', reason: 'not on this machine' }; },
  create() { throw new Error('unreachable'); },
};

async function start(file?: object) {
  const dir = temp();
  const config = records();
  if (file !== undefined) config.set(PLUGINS, file);
  host = createPluginHost({
    pluginDir: join(dir, 'plugins'), config, dataDir: dir, clock: fixedClock, logger: { info() {}, warn() {} },
    kit: fakeKit(), builtins: [...BUILTIN_PLUGINS, throwing, garbage, duplicating, unavailable],
    defaultExecutors: [{ name: 'test', plugin: 'test' }], intervalMs: 30,
  });
  await host.start();
  return { host, config };
}

describe('the plugin host\'s queue sorter', () => {
  it('no queueSorter section: the built-in priority instance', async () => {
    const { host } = await start({ version: 1 });
    expect(host.queueSorter.name).toBe('priority');
    expect(host.report().queueSorter).toEqual({ instance: { name: 'priority', plugin: 'priority' }, detection: { status: 'available' }, active: 'priority', fallback: false });
    expect(host.report().instances).toContainEqual({ role: 'queue-sorter', instance: { name: 'priority', plugin: 'priority' } });
  });

  it('named in the plugins config: that instance; a config change swaps it live', async () => {
    const { host, config } = await start({ version: 1, queueSorter: { name: 'fifo', plugin: 'oldest-first' } });
    expect(host.queueSorter.sort(ENTRIES)).toEqual(['old', 'a', 'b', 'new']);
    config.set(PLUGINS, { version: 1, queueSorter: { name: 'lifo', plugin: 'newest-first' } });
    await waitFor(() => host.report().queueSorter.active === 'newest-first', { what: 'the sorter to swap' });
    expect(host.queueSorter.name).toBe('lifo');
    expect(host.queueSorter.sort(ENTRIES)).toEqual(['new', 'a', 'b', 'old']);
  });

  it.each([
    ['unknown plugin', 'no-such-sorter', /unknown queue-sorter plugin no-such-sorter/],
    ['unavailable', 'absent-sorter', /not on this machine/],
  ])('%s: priority answers, fallback with the reason', async (_n, plugin, why) => {
    const { host } = await start({ version: 1, queueSorter: { name: 's', plugin } });
    expect(host.queueSorter.sort(ENTRIES)).toEqual(['new', 'a', 'b', 'old']);
    expect(host.report().queueSorter).toMatchObject({ instance: { name: 's', plugin }, active: 'priority', fallback: true, reason: expect.stringMatching(why) });
  });

  it.each([
    ['throws', 'throwing-sorter', /sort blew up/],
    ['returns garbage', 'garbage-sorter', /not a list of job ids/],
    ['names a job twice', 'duplicating-sorter', /names job b twice/],
  ])('a sorter that %s: that call answers with priority; fallback with the reason', async (_n, plugin, why) => {
    const { host } = await start({ version: 1, queueSorter: { name: 's', plugin } });
    expect(host.report().queueSorter.fallback).toBe(false);
    expect(host.queueSorter.sort(ENTRIES)).toEqual(['new', 'a', 'b', 'old']);
    expect(host.report().queueSorter).toMatchObject({ active: plugin, fallback: true, reason: expect.stringMatching(why) });
  });

  it('the UI selects a queue sorter like the router', async () => {
    const { host, config } = await start({ version: 1 });
    const r = await host.edit({ action: 'select', role: 'queue-sorter', plugin: 'oldest-first', version: host.report().config.version });
    expect(r.ok).toBe(true);
    expect(host.report().queueSorter.instance).toMatchObject({ name: 'oldest-first', plugin: 'oldest-first' });
    expect(config.read(PLUGINS)).toMatchObject({ queueSorter: { name: 'oldest-first', plugin: 'oldest-first' } });
  });
});
