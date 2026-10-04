// Phase 5 slice 3: the executor role in the plugin host. Executors are a restart role: built once
// at start from plugins.yaml `executors:` (or the env-derived instances); an instance that cannot
// run is reported with its reason so its jobs are held; a later edit of the section shows
// `changed — restart pending` and changes nothing until restart.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor } from '../../src/domain/ports.ts';
import type { InstanceSpec } from '../../src/domain/types.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { createPluginHost, type PluginHost } from '../../src/plugins/index.ts';
import type { DetectionKit, PluginDefinition } from '../../src/plugins/sdk.ts';
import { waitFor } from '../support/wait.ts';
import { fakeKit, fixedClock, useTempDirs } from './support.ts';

const temp = useTempDirs();
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

function start(o: { file?: string; kit?: DetectionKit; defaultExecutors?: InstanceSpec[] } = {}) {
  const dir = temp();
  const pluginsFile = join(dir, 'plugins.yaml');
  if (o.file !== undefined) writeFileSync(pluginsFile, o.file, { mode: 0o600 });
  host = createPluginHost({
    pluginDir: join(dir, 'plugins'), pluginsFile, dataDir: dir, clock: fixedClock,
    logger: { info() {}, warn() {} }, routerMode: () => 'shadow', kit: o.kit ?? fakeKit(),
    builtins: [...BUILTIN_PLUGINS, brokenExecutor, selfNamed],
    defaultRouter: { name: 'open', plugin: 'pass-through' },
    defaultAnswerer: null,
    defaultAssessor: { name: 'a', plugin: 'always-escalate' },
    defaultExecutors: o.defaultExecutors ?? ENV_EXECUTORS,
    intervalMs: 30,
  });
  return { host, pluginsFile };
}

const names = (h: PluginHost) => h.executors().filter((e) => e.executor).map((e) => e.executor!.name);

describe('executor instances', () => {
  it('no plugins.yaml: the env-derived instances, built and detected', async () => {
    const { host } = start();
    await host.start();
    expect(names(host)).toEqual(['test', 'herdr-claude']);
    const r = host.report();
    expect(r.roles).toContain('executor');
    expect(r.executors.instances).toEqual([
      { instance: { name: 'test', plugin: 'test' }, detection: { status: 'available' }, active: 'test' },
      { instance: ENV_EXECUTORS[1], detection: { status: 'available', detail: expect.any(String) }, active: 'herdr-claude' },
    ]);
    expect(r.executors.pending).toBeUndefined();
  });

  it('plugins.yaml `executors:` wins over the env', async () => {
    const { host } = start({ file: 'version: 1\nexecutors: [ { name: t2, plugin: test } ]\n' });
    await host.start();
    expect(names(host)).toEqual(['t2']);
    expect(host.report().executors.instances.map((i) => i.instance.name)).toEqual(['t2']);
  });

  it('the instance name wins over what the plugin calls itself', async () => {
    const { host } = start({ file: 'version: 1\nexecutors: [ { name: mine, plugin: self-named } ]\n' });
    await host.start();
    const [built] = host.executors();
    expect(built!.executor!.name).toBe('mine');
    expect(await built!.executor!.run({} as never)).toEqual({ kind: 'finished', result: {} });
  });

  it.each([
    ['unknown plugin', '{ name: x, plugin: no-such-executor }', /unknown executor plugin no-such-executor/],
    ['invalid options', '{ name: x, plugin: self-named, options: { tag: 3 } }', /options.*tag/],
    ['create throws', '{ name: x, plugin: broken-executor }', /cannot create: no backend/],
    ['a router plugin named as an executor', '{ name: x, plugin: pass-through }', /unknown executor plugin pass-through/],
  ])('%s: unavailable with the reason; the others still run', async (_n, entry, why) => {
    const { host } = start({ file: `version: 1\nexecutors: [ { name: test, plugin: test }, ${entry} ]\n` });
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

describe('executors are a restart role', () => {
  it('an edit of `executors:` shows changed — restart pending and changes nothing; reverting clears it', async () => {
    const { host, pluginsFile } = start({ file: 'version: 1\nexecutors: [ { name: test, plugin: test } ]\n' });
    await host.start();
    writeFileSync(pluginsFile, 'version: 1\nexecutors: [ { name: test, plugin: test }, { name: t2, plugin: test } ]\n', { mode: 0o600 });
    await host.reload();
    expect(host.report().executors.pending).toEqual({
      status: 'changed — restart pending',
      instances: [{ name: 'test', plugin: 'test', options: {} }, { name: 't2', plugin: 'test', options: {} }],
    });
    expect(names(host)).toEqual(['test']);
    expect(host.report().executors.instances.map((i) => i.instance.name)).toEqual(['test']);

    writeFileSync(pluginsFile, 'version: 1\nexecutors: [ { name: test, plugin: test } ]\n', { mode: 0o600 });
    await waitFor(() => host.report().executors.pending === undefined, { what: 'pending to clear' });
  });

  it('removing the section falls back to the env-derived instances: pending if they differ', async () => {
    const { host, pluginsFile } = start({ file: 'version: 1\nexecutors: [ { name: test, plugin: test } ]\n' });
    await host.start();
    writeFileSync(pluginsFile, 'version: 1\n', { mode: 0o600 });
    await host.reload();
    expect(host.report().executors.pending).toEqual({ status: 'changed — restart pending', instances: ENV_EXECUTORS });
  });

  it('an invalid file keeps the running executors and shows no change', async () => {
    const { host, pluginsFile } = start({ file: 'version: 1\nexecutors: [ { name: test, plugin: test } ]\n' });
    await host.start();
    writeFileSync(pluginsFile, 'version: 1\nexecutors: []\n', { mode: 0o600 });
    await host.reload();
    expect(host.report().config.error).toMatch(/executors/);
    expect(host.report().executors.pending).toBeUndefined();
    expect(names(host)).toEqual(['test']);
  });
});
