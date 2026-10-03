// The plugin host: built-in + custom plugins, plugins.yaml (router section) with an mtime watch,
// detection, and the live router with its fallback to pass-through.
import { cpSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { createPluginHost, type PluginHost, type PluginHostOptions } from '../../src/plugins/index.ts';
import type { DetectionKit, PluginDefinition } from '../../src/plugins/sdk.ts';
import { waitFor } from '../support/wait.ts';
import { ALWAYS_PROCEED_DIR, fakeKit, fixedClock, useTempDirs, writePlugin } from './support.ts';

const temp = useTempDirs();
const job = { id: 'j1', spec: { executor: 'test', payload: {} } } as Job;
let host: PluginHost | undefined;
afterEach(() => { host?.stop(); host = undefined; });

/** A router that tags its advice with its instance options, so a swap is visible. */
const tagging: PluginDefinition<'router'> = {
  id: 'tagging', role: 'router', describe: 'tags advice',
  options: (z) => z.object({ tag: z.string(), gate: z.boolean().default(false) }),
  async detect() { return { status: 'available' }; },
  create(ctx, o: { tag: string }) {
    return { name: 'tagging', async advise() { return { action: 'chat_only', reason: o.tag, details: {}, source: 'tagging', at: ctx.clock.now().toISOString() }; } };
  },
};
const brokenCreate: PluginDefinition<'router'> = {
  ...tagging, id: 'broken-create', options: undefined, create() { throw new Error('cannot start'); },
};
const throwingAdvise: PluginDefinition<'router'> = {
  ...tagging, id: 'throwing', options: undefined,
  create() { return { name: 'throwing', async advise() { throw new Error('advise blew up'); } }; },
};
let selfFallback = true;
const selfFallingBack: PluginDefinition<'router'> = {
  ...tagging, id: 'self-fallback', options: undefined,
  create(ctx) {
    return { name: 'self-fallback', async advise() {
      return { action: 'proceed_full', reason: selfFallback ? 'jev unavailable: x' : 'ok', details: {}, source: selfFallback ? 'fallback' : 'self-fallback', at: ctx.clock.now().toISOString() };
    } };
  },
};

function start(o: { file?: string; kit?: DetectionKit; defaultRouter?: PluginHostOptions['defaultRouter']; pluginDir?: string } = {}) {
  const dir = temp();
  const pluginsFile = join(dir, 'plugins.yaml');
  if (o.file !== undefined) writeFileSync(pluginsFile, o.file, { mode: 0o600 });
  host = createPluginHost({
    pluginDir: o.pluginDir ?? join(dir, 'plugins'), pluginsFile, dataDir: dir, clock: fixedClock,
    logger: { info() {}, warn() {} }, routerMode: () => 'shadow', kit: o.kit ?? fakeKit(),
    builtins: [...BUILTIN_PLUGINS, tagging, brokenCreate, throwingAdvise, selfFallingBack],
    defaultRouter: o.defaultRouter ?? { name: 'jev', plugin: 'jev-router', options: { jevSrc: '/jev', python: 'python3' } },
    intervalMs: 30,
  });
  return { host, pluginsFile };
}

describe('router instance from the environment (no plugins.yaml)', () => {
  it('uses the default instance when its plugin is available', async () => {
    const { host } = start({ defaultRouter: { name: 'tg', plugin: 'tagging', options: { tag: 'env' } } });
    await host.start();
    expect(host.routerStatus()).toEqual({ name: 'tg', plugin: 'tagging', fallback: false });
    expect(await host.router.advise(job)).toMatchObject({ reason: 'env', source: 'tagging' });
    expect(host.router.name).toBe('tg');
    expect(host.report().config).toMatchObject({ source: 'env' });
  });

  it('jev-router unavailable (no Jev checkout) → pass-through, advice source fallback', async () => {
    const { host } = start({ kit: fakeKit({ exists: async () => false }) });
    await host.start();
    expect(host.routerStatus()).toEqual({ name: 'jev', plugin: 'pass-through', fallback: true, reason: expect.stringContaining('/jev/src/router.py') });
    const advice = await host.router.advise(job);
    expect(advice).toMatchObject({ action: 'proceed_full', source: 'fallback', at: '2026-10-03T12:00:00.000Z' });
    expect(advice.reason).toMatch(/^router jev unavailable: /);
    expect(host.report().router).toMatchObject({
      instance: { name: 'jev', plugin: 'jev-router' }, active: 'pass-through', fallback: true,
      detection: { status: 'unavailable' },
    });
  });
});

describe('fallback to pass-through', () => {
  it.each([
    ['create throws', 'router: { name: b, plugin: broken-create }', /cannot start/],
    ['unknown plugin', 'router: { name: u, plugin: no-such-plugin }', /unknown router plugin no-such-plugin/],
    ['invalid options', 'router: { name: t, plugin: tagging, options: { tag: 3 } }', /options.*tag/],
  ])('%s', async (_name, section, why) => {
    const { host } = start({ file: `version: 1\n${section}\n` });
    await host.start();
    expect(host.routerStatus()).toMatchObject({ plugin: 'pass-through', fallback: true, reason: expect.stringMatching(why) });
    expect(await host.router.advise(job)).toMatchObject({ action: 'proceed_full', source: 'fallback' });
  });

  it('a router whose advise throws gives fallback advice, never a rejection', async () => {
    const { host } = start({ file: 'version: 1\nrouter: { name: x, plugin: throwing }\n' });
    await host.start();
    const advice = await host.router.advise(job);
    expect(advice).toMatchObject({ action: 'proceed_full', source: 'fallback', reason: expect.stringContaining('advise blew up') });
    expect(host.routerStatus().fallback).toBe(true);
  });

  it('advice the router itself marks fallback shows as fallback until it recovers', async () => {
    selfFallback = true;
    const { host } = start({ file: 'version: 1\nrouter: { name: s, plugin: self-fallback }\n' });
    await host.start();
    expect(host.routerStatus()).toEqual({ name: 's', plugin: 'self-fallback', fallback: false });
    await host.router.advise(job);
    expect(host.routerStatus()).toEqual({ name: 's', plugin: 'self-fallback', fallback: true, reason: 'jev unavailable: x' });
    selfFallback = false;
    await host.router.advise(job);
    expect(host.routerStatus().fallback).toBe(false);
  });
});

describe('plugins.yaml live reload (router swaps between calls)', () => {
  it('a changed router section swaps the router; a broken edit keeps the last good one; removal returns to env', async () => {
    const { host, pluginsFile } = start({
      file: 'version: 1\nrouter: { name: one, plugin: tagging, options: { tag: first } }\n',
      defaultRouter: { name: 'env', plugin: 'pass-through' },
    });
    await host.start();
    expect(host.report().config).toMatchObject({ source: 'file', path: pluginsFile });
    expect((await host.router.advise(job)).reason).toBe('first');

    writeFileSync(pluginsFile, 'version: 1\nrouter: { name: two, plugin: tagging, options: { tag: second-one } }\n');
    await waitFor(async () => (await host.router.advise(job)).reason === 'second-one', { what: 'the swapped router' });
    expect(host.routerStatus()).toEqual({ name: 'two', plugin: 'tagging', fallback: false });

    writeFileSync(pluginsFile, 'version: 1\nrouter: [broken\n');
    await waitFor(() => host.report().config.error, { what: 'the config error' });
    expect((await host.router.advise(job)).reason).toBe('second-one');

    rmSync(pluginsFile);
    await waitFor(() => host.routerStatus().name === 'env', { what: 'the env router' });
    expect(host.report().config).toMatchObject({ source: 'env' });
    expect(host.report().config.error).toBeUndefined();
    expect(await host.router.advise(job)).toMatchObject({ source: 'pass-through' });
  });

  it('reload() re-reads now', async () => {
    const { host, pluginsFile } = start({ file: 'version: 1\nrouter: { name: one, plugin: tagging, options: { tag: a } }\n' });
    await host.start();
    host.stop();
    writeFileSync(pluginsFile, 'version: 1\nrouter: { name: one, plugin: tagging, options: { tag: bb } }\n');
    await host.reload();
    expect((await host.router.advise(job)).reason).toBe('bb');
  });
});

describe('custom plugins through the host', () => {
  it('a custom router named in plugins.yaml advises', async () => {
    const pluginDir = temp();
    cpSync(ALWAYS_PROCEED_DIR, join(pluginDir, 'always-proceed'), { recursive: true });
    const { host } = start({ pluginDir, file: 'version: 1\nrouter: { name: mine, plugin: always-proceed, options: { note: custom } }\n' });
    await host.start();
    expect(host.routerStatus()).toEqual({ name: 'mine', plugin: 'always-proceed', fallback: false });
    expect(await host.router.advise(job)).toMatchObject({ reason: 'custom', source: 'always-proceed' });
  });

  it('report: roles, every router plugin with builtin flag, detection and options schema, and load errors', async () => {
    const pluginDir = temp();
    cpSync(ALWAYS_PROCEED_DIR, join(pluginDir, 'always-proceed'), { recursive: true });
    writePlugin(pluginDir, 'clash', "export default { id: 'pass-through', role: 'router', describe: 'x', async detect() { return { status: 'available' }; }, create() {} };\n", 'index.js');
    const { host } = start({ pluginDir, kit: fakeKit({ exists: async () => false }) });
    await host.start();
    const r = host.report();
    expect(r.roles).toEqual(['router']);
    const byId = new Map(r.plugins.map((p) => [p.id, p]));
    expect(byId.get('jev-router')).toMatchObject({
      role: 'router', builtin: true, detection: { status: 'unavailable' },
      options: { type: 'object', properties: { jevSrc: { type: 'string' }, python: { type: 'string' } } },
    });
    expect(byId.get('pass-through')).toMatchObject({ builtin: true, detection: { status: 'available' } });
    expect(byId.get('always-proceed')).toMatchObject({
      builtin: false, path: join(pluginDir, 'always-proceed', 'index.ts'), describe: 'Admits every job as proceed_full',
      detection: { status: 'available' }, options: { properties: { note: { type: 'string' } } },
    });
    expect(r.errors).toEqual([{ path: join(pluginDir, 'clash', 'index.js'), error: expect.stringMatching(/built-in/) }]);
  });

  it('a plugin whose detect throws is reported unavailable', async () => {
    const pluginDir = temp();
    writePlugin(pluginDir, 'det', "export default { id: 'det', role: 'router', describe: 'x', async detect() { throw new Error('probe failed'); }, create() {} };\n", 'index.js');
    const { host } = start({ pluginDir });
    await host.start();
    expect(host.report().plugins.find((p) => p.id === 'det')!.detection).toEqual({ status: 'unavailable', reason: expect.stringContaining('probe failed') });
  });
});
