// Phase 5 slice 3: the executor role in the plugin host, built from the plugins config `executors:` (or the
// env-derived instances); an instance that cannot run is reported with its reason so its jobs are
// held. Since the owner decision on issue #142 (shipped plugins are enabled and disabled in the UI,
// never by a restart) executors follow the plugins config live: an unchanged instance is kept, a new or
// changed one built, a removed one dropped.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor } from '../../src/domain/ports.ts';
import type { InstanceSpec } from '../../src/domain/types.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { createPluginHost, type PluginHost } from '../../src/plugins/index.ts';
import type { DetectionKit, PluginDefinition } from '../../src/plugins/sdk.ts';
import { PLUGINS } from '../../src/plugins/plugins-config.ts';
import { useTempConfig } from '../support/config.ts';
import { fakeKit, fixedClock, useTempDirs } from './support.ts';

const temp = useTempDirs();
const records = useTempConfig();
let host: PluginHost | undefined;
afterEach(() => { host?.stop(); host = undefined; });

const brokenExecutor: PluginDefinition<'executor'> = {
  id: 'broken-executor', role: 'executor', describe: 'cannot start',
  async detect() { return { status: 'available' }; },
  create() { throw new Error('no backend'); },
};
/** Calls itself "self-named"; the instance name must win (jobs name the instance). */
const selfNamed: PluginDefinition<'executor'> = {
  id: 'self-named', role: 'executor', describe: 'names itself',
  options: (z) => z.object({ tag: z.string().default('x') }),
  async detect() { return { status: 'available' }; },
  create(): Executor {
    return { name: 'self-named', idempotent: true, validate: () => null, run: async () => ({ kind: 'finished', result: {} }) };
  },
};

const ENV_EXECUTORS: InstanceSpec[] = [
  { name: 'test', plugin: 'test' },
  { name: 'herdr-claude', plugin: 'herdr-claude', options: { bin: 'herdr', claudeBin: 'claude', cwd: '/w' } },
];

function start(o: { file?: object; kit?: DetectionKit; defaultExecutors?: InstanceSpec[] } = {}) {
  const dir = temp();
  const config = records();
  if (o.file !== undefined) config.set(PLUGINS, o.file);
  host = createPluginHost({
    pluginDir: join(dir, 'plugins'), config, dataDir: dir, clock: fixedClock,
    logger: { info() {}, warn() {} }, kit: o.kit ?? fakeKit(),
    builtins: [...BUILTIN_PLUGINS, brokenExecutor, selfNamed],
    defaultLevels: [],
    defaultExecutors: o.defaultExecutors ?? ENV_EXECUTORS,
    intervalMs: 30,
  });
  return { host, config };
}

const names = (h: PluginHost) => h.executors().filter((e) => e.executor).map((e) => e.executor!.name);

describe('executor instances', () => {
  it('no plugins config: the env-derived instances, built and detected', async () => {
    const { host } = start();
    await host.start();
    expect(names(host)).toEqual(['test', 'herdr-claude']);
    const r = host.report();
    expect(r.roles).toContain('executor');
    expect(r.executors.instances).toEqual([
      { instance: { name: 'test', plugin: 'test' }, detection: { status: 'available' }, active: 'test' },
      { instance: ENV_EXECUTORS[1], detection: { status: 'available', detail: expect.any(String) }, active: 'herdr-claude' },
    ]);
    expect(r.executors).not.toHaveProperty('pending');
  });

  it('the plugins config `executors:` wins over the env', async () => {
    const { host } = start({ file: { version: 1, executors: [{ name: 't2', plugin: 'test' }] } });
    await host.start();
    expect(names(host)).toEqual(['t2']);
    expect(host.report().executors.instances.map((i) => i.instance.name)).toEqual(['t2']);
  });

  it('the instance name wins over what the plugin calls itself', async () => {
    const { host } = start({ file: { version: 1, executors: [{ name: 'mine', plugin: 'self-named' }] } });
    await host.start();
    const [built] = host.executors();
    expect(built!.executor!.name).toBe('mine');
    expect(await built!.executor!.run({} as never)).toEqual({ kind: 'finished', result: {} });
  });

  it.each([
    ['unknown plugin', { name: 'x', plugin: 'no-such-executor' }, /unknown executor plugin no-such-executor/],
    ['invalid options', { name: 'x', plugin: 'self-named', options: { tag: 3 } }, /options.*tag/],
    ['create throws', { name: 'x', plugin: 'broken-executor' }, /cannot create: no backend/],
    ['a router plugin named as an executor', { name: 'x', plugin: 'pass-through' }, /unknown executor plugin pass-through/],
  ])('%s: unavailable with the reason; the others still run', async (_n, entry, why) => {
    const { host } = start({ file: { version: 1, executors: [{ name: 'test', plugin: 'test' }, entry] } });
    await host.start();
    expect(names(host)).toEqual(['test']);
    const x = host.executors().find((e) => e.spec.name === 'x')!;
    expect(x.executor).toBeUndefined();
    expect(x.reason).toMatch(why);
    expect(host.report().executors.instances[1]).toMatchObject({ instance: { name: 'x' }, active: null, reason: expect.stringMatching(why) });
  });

  it('not detected (herdr absent): unavailable, with the detection', async () => {
    const { host } = start({ kit: fakeKit({ which: async (bin) => (bin === 'herdr' ? undefined : `/usr/bin/${bin}`) }) });
    await host.start();
    expect(names(host)).toEqual(['test']);
    expect(host.report().executors.instances[1]).toMatchObject({
      instance: { name: 'herdr-claude' }, active: null,
      detection: { status: 'unavailable', reason: 'herdr not found: herdr' }, reason: 'herdr not found: herdr',
    });
  });

  it('every executor plugin is in the catalogue with its detection', async () => {
    const { host } = start();
    await host.start();
    const byId = new Map(host.report().plugins.map((p) => [p.id, p]));
    expect(byId.get('herdr-claude')).toMatchObject({ role: 'executor', builtin: true, detection: { status: 'available' } });
    expect(byId.get('test')).toMatchObject({ role: 'executor', builtin: true, detection: { status: 'available' } });
  });
});

describe('executors follow the plugins config live (issue #142)', () => {
  it('an added instance runs at once, an unchanged one is kept as it is, a removed one is gone; nothing is pending', async () => {
    const { host, config } = start({ file: { version: 1, executors: [{ name: 'test', plugin: 'test' }] } });
    await host.start();
    const before = host.executors()[0]!.executor;
    config.set(PLUGINS, { version: 1, executors: [{ name: 'test', plugin: 'test' }, { name: 't2', plugin: 'test' }] });
    await host.reload();
    expect(names(host)).toEqual(['test', 't2']);
    expect(host.executors()[0]!.executor).toBe(before);
    expect(host.report().executors).not.toHaveProperty('pending');
    expect(host.report().executors.instances.map((i) => i.instance.name)).toEqual(['test', 't2']);

    config.set(PLUGINS, { version: 1, executors: [{ name: 't2', plugin: 'test' }] });
    await host.reload();
    expect(names(host)).toEqual(['t2']);
  });

  it('removing the section brings back the env-derived instances', async () => {
    const { host, config } = start({ file: { version: 1, executors: [{ name: 'test', plugin: 'test' }] } });
    await host.start();
    config.set(PLUGINS, { version: 1 });
    await host.reload();
    expect(host.executors().map((e) => e.spec)).toEqual(ENV_EXECUTORS);
  });

  it('an invalid config keeps the running executors', async () => {
    const { host, config } = start({ file: { version: 1, executors: [{ name: 'test', plugin: 'test' }] } });
    await host.start();
    config.set(PLUGINS, { version: 1, executors: [] });
    await host.reload();
    expect(host.report().config.error).toMatch(/executors/);
    expect(names(host)).toEqual(['test']);
  });
});
