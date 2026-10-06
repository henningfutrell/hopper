// Phase 5 slice 5: the notifier role in the plugin host. 0..n instances, a restart role: built once
// at start from the plugins config (an absent section → the built-in grok-bot instance; `notifiers: []` → none), started with the event feed, stopped with the daemon. A
// notifier that cannot run — unknown plugin, invalid options, unavailable, create or start throwing —
// is dropped with its reason in the report; never a boot failure. grokbot-routine's detection looks
// at its two environment variables only (never runs the Grok Bot GUI); needs-setup still runs,
// because they are read at each event and one set later applies without a restart.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Notifier, NotifierEvents } from '../../src/domain/ports.ts';
import type { DomainEvent } from '../../src/domain/types.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { createPluginHost, type PluginHost } from '../../src/plugins/index.ts';
import type { DetectionKit, PluginDefinition } from '../../src/plugins/sdk.ts';
import { PLUGINS } from '../../src/plugins/plugins-config.ts';
import { useTempConfig } from '../support/config.ts';
import { fakeKit, fixedClock, useTempDirs } from './support.ts';

const temp = useTempDirs();
const records = useTempConfig();
let host: PluginHost | undefined;
afterEach(async () => { await host?.stopNotifiers(); host?.stop(); host = undefined; });

const started: string[] = [];
const stopped: string[] = [];

/** A notifier recording what it saw; `fail` makes start throw. */
const recorder: PluginDefinition<'notifier'> = {
  id: 'recorder', role: 'notifier', describe: 'records events',
  options: (z) => z.object({ fail: z.enum(['no', 'create', 'start']).default('no') }),
  async detect() { return { status: 'available' }; },
  create(ctx, o): Notifier {
    if (o.fail === 'create') throw new Error('create boom');
    return {
      name: 'recorder',
      start(events) {
        if (o.fail === 'start') throw new Error('start boom');
        started.push(ctx.instanceName);
        events.subscribe(() => {});
      },
      async stop() { stopped.push(ctx.instanceName); },
    };
  },
};

const unavailable: PluginDefinition<'notifier'> = {
  id: 'never-here', role: 'notifier', describe: 'cannot run here',
  async detect() { return { status: 'unavailable', reason: 'not on this machine' }; },
  create() { throw new Error('must not be created'); },
};

const feed = (): NotifierEvents & { listeners: ((e: DomainEvent) => void)[] } => {
  const listeners: ((e: DomainEvent) => void)[] = [];
  return {
    listeners,
    subscribe(l) { listeners.push(l); return () => { listeners.splice(listeners.indexOf(l), 1); }; },
    job: () => undefined,
  };
};

function start(o: { file?: object; kit?: DetectionKit } = {}) {
  const dir = temp();
  const config = records();
  if (o.file !== undefined) config.set(PLUGINS, o.file);
  host = createPluginHost({
    pluginDir: join(dir, 'plugins'), config, dataDir: dir, clock: fixedClock,
    logger: { info() {}, warn() {} }, routerMode: () => 'shadow', kit: o.kit ?? fakeKit({ exists: async () => false, readable: async () => false }),
    builtins: [...BUILTIN_PLUGINS, recorder, unavailable],
    defaultLevels: [],
    defaultExecutors: [{ name: 'test', plugin: 'test' }],
    intervalMs: 30,
  });
  return { host, config, dir };
}

const catalogue = (h: PluginHost, id: string) => h.report().plugins.find((p) => p.id === id);

describe('the notifier role', () => {
  it('is a role; grokbot-routine is its built-in plugin, urlEnv and keyEnv marked command-bearing', async () => {
    const { host } = start({ file: { version: 1 } });
    await host.start();
    expect(host.report().roles).toContain('notifier');
    const g = catalogue(host, 'grokbot-routine');
    expect(g).toMatchObject({ role: 'notifier', builtin: true });
    const props = (g!.options as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props.urlEnv).toMatchObject({ commandBearing: true });
    expect(props.keyEnv).toMatchObject({ commandBearing: true });
  });

  it('no notifiers section: the built-in grok-bot instance — the Grok Bot routine survives a plugins config written before slice 5', async () => {
    const { host } = start({ file: { version: 1, jobSources: [] } });
    await host.start();
    expect(host.report().notifiers.instances).toEqual([{
      instance: { name: 'grok-bot', plugin: 'grokbot-routine' },
      detection: { status: 'needs-setup', reason: expect.stringContaining('GROKBOT_WEBHOOK_URL'), command: expect.stringContaining('GROKBOT_WEBHOOK_KEY') },
      active: 'grokbot-routine',
    }]);
  });

  it('notifiers: [] → none', async () => {
    const { host } = start({ file: { version: 1, notifiers: [] } });
    await host.start();
    expect(host.report().notifiers.instances).toEqual([]);
    expect(host.notifiers()).toEqual([]);
  });

  it('built from the plugins config, started with the event feed under their instance names, stopped once', async () => {
    const { host } = start({ file: { version: 1, notifiers: [{ name: 'one', plugin: 'recorder' }, { name: 'two', plugin: 'recorder' }] } });
    started.length = 0;
    stopped.length = 0;
    await host.start();
    const events = feed();
    host.startNotifiers(events);
    expect(started).toEqual(['one', 'two']);
    expect(events.listeners).toHaveLength(2);
    expect(host.notifiers().map((n) => n.name)).toEqual(['one', 'two']);
    await host.stopNotifiers();
    await host.stopNotifiers();
    expect(stopped).toEqual(['one', 'two']);
  });

  it.each([
    ['unknown plugin', { name: 'x', plugin: 'no-such-notifier' }, /unknown notifier plugin no-such-notifier/],
    ['invalid options', { name: 'x', plugin: 'recorder', options: { fail: 'maybe' } }, /fail/],
    ['a router plugin named as a notifier', { name: 'x', plugin: 'pass-through' }, /unknown notifier plugin pass-through/],
    ['unavailable', { name: 'x', plugin: 'never-here' }, /not on this machine/],
    ['create throws', { name: 'x', plugin: 'recorder', options: { fail: 'create' } }, /cannot create: create boom/],
    ['start throws', { name: 'x', plugin: 'recorder', options: { fail: 'start' } }, /cannot start: start boom/],
  ])('%s: dropped with the reason in the report; the others still run; never a boot failure', async (_n, entry, why) => {
    const { host } = start({ file: { version: 1, notifiers: [entry, { name: 'ok', plugin: 'recorder' }] } });
    await host.start();
    host.startNotifiers(feed());
    expect(host.notifiers().map((n) => n.name)).toEqual(['ok']);
    expect(host.report().notifiers.instances.map((i) => [i.instance.name, i.active])).toEqual([['x', null], ['ok', 'recorder']]);
    expect(host.report().notifiers.instances[0]!.reason).toMatch(why);
  });

  it('two notifiers with one name are refused', async () => {
    const { host } = start({ file: { version: 1, notifiers: [{ name: 'n', plugin: 'recorder' }, { name: 'n', plugin: 'recorder' }] } });
    await host.start();
    expect(host.report().config.error).toMatch(/notifiers.*twice/);
  });

  it('a restart role: an edit shows changed — restart pending; the running notifiers stay', async () => {
    const { host, config } = start({ file: { version: 1, notifiers: [] } });
    await host.start();
    config.set(PLUGINS, { version: 1, notifiers: [{ name: 'one', plugin: 'recorder' }] });
    await host.reload();
    expect(host.report().notifiers.pending).toEqual({ status: 'changed — restart pending', instances: [{ name: 'one', plugin: 'recorder', options: {} }] });
    expect(host.notifiers()).toEqual([]);
  });
});

describe('grokbot-routine detection: its environment variables only, never the Grok Bot binary', () => {
  const entry = (options?: Record<string, string>) => ({ version: 1, notifiers: [{ name: 'grok-bot', plugin: 'grokbot-routine', ...(options ? { options } : {}) }] });
  const set = (vars: Record<string, string>) => (n: string) => vars[n];

  it('both variables set → available; nothing is run', async () => {
    const ran: string[] = [];
    const kit = fakeKit({
      env: set({ GROKBOT_WEBHOOK_URL: 'http://x/hook', GROKBOT_WEBHOOK_KEY: 'k' }),
      which: async (b) => { ran.push(`which ${b}`); return undefined; },
      version: async (b) => { ran.push(`version ${b}`); return undefined; },
      succeeds: async (b) => { ran.push(`succeeds ${b}`); return false; },
    });
    const { host } = start({ file: entry(), kit });
    await host.start();
    expect(host.report().notifiers.instances[0]).toMatchObject({ detection: { status: 'available' }, active: 'grokbot-routine' });
    expect(ran.filter((r) => /grok/i.test(r))).toEqual([]);
  });

  it('a variable unset → needs-setup naming it; still runs (one set later applies without a restart)', async () => {
    const { host } = start({ file: entry(), kit: fakeKit({ env: set({ GROKBOT_WEBHOOK_URL: 'http://x/hook' }) }) });
    await host.start();
    expect(host.report().notifiers.instances[0]).toEqual({
      instance: { name: 'grok-bot', plugin: 'grokbot-routine', options: {} },
      detection: { status: 'needs-setup', reason: 'no Grok Bot routine configured: GROKBOT_WEBHOOK_KEY not set', command: expect.stringContaining('GROKBOT_WEBHOOK_KEY') },
      active: 'grokbot-routine',
    });
  });

  it('urlEnv and keyEnv rename the variables detection reads', async () => {
    const { host } = start({ file: entry({ urlEnv: 'MY_URL', keyEnv: 'MY_KEY' }), kit: fakeKit({ env: set({ MY_URL: 'http://x/hook', MY_KEY: 'k' }) }) });
    await host.start();
    expect(host.report().notifiers.instances[0]).toMatchObject({ detection: { status: 'available' } });
  });
});
