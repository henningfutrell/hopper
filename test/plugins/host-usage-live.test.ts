// The usage-source role follows the plugins config live (issue #356): an added instance is read at
// once, an unchanged one kept, a removed one stopped and gone — no restart.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageSource } from '../../src/domain/ports.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { createPluginHost, type PluginHost } from '../../src/plugins/index.ts';
import type { PluginDefinition } from '../../src/plugins/sdk.ts';
import { PLUGINS } from '../../src/plugins/plugins-config.ts';
import { useTempConfig } from '../support/config.ts';
import { fakeKit, fixedClock, useTempDirs } from './support.ts';

const temp = useTempDirs();
const records = useTempConfig();
let host: PluginHost | undefined;
const stopped: string[] = [];
afterEach(() => { host?.stop(); host = undefined; stopped.length = 0; });

/** A usage source reporting one fixed reading; records its stop. */
const fixedUsage: PluginDefinition<'usage-source'> = {
  id: 'fixed-usage', role: 'usage-source', describe: 'one fixed reading',
  options: (z) => z.object({ used: z.number().default(10) }),
  async detect() { return { status: 'available' }; },
  create(ctx, o): UsageSource {
    return {
      name: 'fixed-usage',
      stop: () => { stopped.push(ctx.instanceName); },
      poll: async () => [{ source: 'fixed-usage', used: o.used, limit: 100, unit: '%', at: ctx.clock.now().toISOString() }],
    };
  },
};

function start(file: object) {
  const dir = temp();
  const config = records();
  config.set(PLUGINS, file);
  host = createPluginHost({
    pluginDir: join(dir, 'plugins'), config, dataDir: dir, clock: fixedClock,
    logger: { info() {}, warn() {} }, kit: fakeKit({ exists: async () => false }),
    builtins: [...BUILTIN_PLUGINS, fixedUsage], defaultLevels: [], defaultExecutors: [{ name: 'test', plugin: 'test' }], intervalMs: 30,
  });
  return { host, config };
}

describe('the usage-source role, live (issue #356)', () => {
  it('an added usage source is read at once; a removed one is stopped and goes; an unchanged one is kept', async () => {
    const { host, config } = start({ version: 1, usageSources: [{ name: 'a', plugin: 'fixed-usage', options: { used: 10 } }] });
    await host.start();
    const [a] = host.usageSources();
    config.set(PLUGINS, { version: 1, usageSources: [{ name: 'a', plugin: 'fixed-usage', options: { used: 10 } }, { name: 'b', plugin: 'fixed-usage', options: { used: 30 } }] });
    await host.reload();
    expect(host.usageSources().map((u) => u.name)).toEqual(['a', 'b']);
    expect(host.usageSources()[0]).toBe(a);
    expect((await host.usageSources()[1]!.poll())[0]).toMatchObject({ used: 30 });
    config.set(PLUGINS, { version: 1, usageSources: [{ name: 'b', plugin: 'fixed-usage', options: { used: 30 } }] });
    await host.reload();
    expect(host.usageSources().map((u) => u.name)).toEqual(['b']);
    expect(stopped).toEqual(['a']);
    expect(host.report().usageSources).toEqual({ instances: [expect.objectContaining({ instance: expect.objectContaining({ name: 'b' }), active: 'fixed-usage' })] });
  });

  it('an options change replaces the instance: the old one is stopped, the new one read', async () => {
    const { host, config } = start({ version: 1, usageSources: [{ name: 'a', plugin: 'fixed-usage', options: { used: 10 } }] });
    await host.start();
    config.set(PLUGINS, { version: 1, usageSources: [{ name: 'a', plugin: 'fixed-usage', options: { used: 55 } }] });
    await host.reload();
    expect(stopped).toEqual(['a']);
    expect((await host.usageSources()[0]!.poll())[0]).toMatchObject({ used: 55 });
  });
});

/** A usage source whose account resolves to the meter `meter.now` (issue #2966): its state says so. */
const meter: { now: 'live' | 'analytics' | undefined } = { now: undefined };
const meteredUsage: PluginDefinition<'usage-source'> = {
  id: 'metered-usage', role: 'usage-source', describe: 'an account of one meter',
  options: (z) => z.object({}),
  async detect() { return { status: 'available' }; },
  create(ctx): UsageSource {
    return { name: ctx.instanceName, poll: async () => [], state: () => (meter.now ? { meter: meter.now } : {}) };
  },
};

function startMetered(file: object) {
  const dir = temp();
  const config = records();
  config.set(PLUGINS, file);
  host = createPluginHost({
    pluginDir: join(dir, 'plugins'), config, dataDir: dir, clock: fixedClock,
    logger: { info() {}, warn() {} }, kit: fakeKit({ exists: async () => false }),
    builtins: [...BUILTIN_PLUGINS, meteredUsage], defaultLevels: [], defaultExecutors: [{ name: 'test', plugin: 'test' }], intervalMs: 30,
  });
  return { host, config };
}

const names = (h: PluginHost) => h.usageSources().map((u) => u.name);
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); expect(ok()).toBe(true); };

describe('the implicit claude-analytics source (issue #2966)', () => {
  afterEach(() => { meter.now = undefined; });

  it('runs once an account resolves to the analytics meter, with the default options, and goes when none does', async () => {
    const { host } = startMetered({ version: 1, usageSources: [{ name: 'claude', plugin: 'metered-usage' }] });
    meter.now = 'live';
    await host.start();
    expect(names(host)).toEqual(['claude']);
    meter.now = 'analytics';
    await until(() => names(host).includes('claude-analytics'));
    expect(names(host)).toEqual(['claude', 'claude-analytics']);
    expect(host.report().usageSources.instances.find((b) => b.instance.name === 'claude-analytics'))
      .toMatchObject({ instance: { name: 'claude-analytics', plugin: 'claude-analytics' }, active: 'claude-analytics' });
    // Never written to the plugins config: the configured instances stay as the config names them.
    expect(host.report().instances.filter((c) => c.role === 'usage-source').map((c) => c.instance.name)).toEqual(['claude']);
    meter.now = 'live';
    await until(() => !names(host).includes('claude-analytics'));
    expect(names(host)).toEqual(['claude']);
  });

  it('an explicit claude-analytics instance wins: no second one runs', async () => {
    meter.now = 'analytics';
    const { host } = startMetered({ version: 1, usageSources: [{ name: 'claude', plugin: 'metered-usage' }, { name: 'daily', plugin: 'claude-analytics', options: { intervalSeconds: 7200 } }] });
    await host.start();
    await new Promise((r) => setTimeout(r, 120));
    expect(names(host)).toEqual(['claude', 'daily']);
  });

  it('a taken name gets -2', async () => {
    meter.now = 'analytics';
    const { host } = startMetered({ version: 1, usageSources: [{ name: 'claude-analytics', plugin: 'metered-usage' }] });
    await host.start();
    await until(() => names(host).length === 2);
    expect(names(host)).toEqual(['claude-analytics', 'claude-analytics-2']);
  });
});
