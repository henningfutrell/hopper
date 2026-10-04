// Phase 5 slice 5: the notifier role in the plugin host. 0..n instances, a restart role: built once
// at start from plugins.yaml (an absent section → the built-in grok-bot instance, its env file beside
// plugins.yaml; `notifiers: []` → none), started with the event feed, stopped with the daemon. A
// notifier that cannot run — unknown plugin, invalid options, unavailable, create or start throwing —
// is dropped with its reason in the report; never a boot failure. grokbot-routine's detection looks
// at its env file only (never runs the Grok Bot GUI); needs-setup still runs, because the file is
// read at each event and one created later applies without a restart.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Notifier, NotifierEvents } from '../../src/domain/ports.ts';
import type { DomainEvent } from '../../src/domain/types.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { createPluginHost, type PluginHost } from '../../src/plugins/index.ts';
import type { DetectionKit, PluginDefinition } from '../../src/plugins/sdk.ts';
import { fakeKit, fixedClock, useTempDirs } from './support.ts';

const temp = useTempDirs();
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

function start(o: { file?: string; kit?: DetectionKit } = {}) {
  const dir = temp();
  const pluginsFile = join(dir, 'plugins.yaml');
  if (o.file !== undefined) writeFileSync(pluginsFile, o.file, { mode: 0o600 });
  host = createPluginHost({
    pluginDir: join(dir, 'plugins'), pluginsFile, dataDir: dir, clock: fixedClock,
    logger: { info() {}, warn() {} }, routerMode: () => 'shadow', kit: o.kit ?? fakeKit({ exists: async () => false, readable: async () => false }),
    builtins: [...BUILTIN_PLUGINS, recorder, unavailable],
    defaultAnswerer: null,
    defaultAssessor: { name: 'a', plugin: 'always-escalate' },
    defaultExecutors: [{ name: 'test', plugin: 'test' }],
    intervalMs: 30,
  });
  return { host, pluginsFile, dir };
}

const catalogue = (h: PluginHost, id: string) => h.report().plugins.find((p) => p.id === id);

describe('the notifier role', () => {
  it('is a role; grokbot-routine is its built-in plugin, envFile marked command-bearing', async () => {
    const { host } = start({ file: 'version: 1\n' });
    await host.start();
    expect(host.report().roles).toContain('notifier');
    const g = catalogue(host, 'grokbot-routine');
    expect(g).toMatchObject({ role: 'notifier', builtin: true });
    expect((g!.options as { properties: Record<string, Record<string, unknown>> }).properties.envFile).toMatchObject({ commandBearing: true });
  });

  it('no notifiers section: the built-in grok-bot instance, its env file beside plugins.yaml — the Grok Bot routine survives a plugins.yaml written before slice 5', async () => {
    const { host, dir } = start({ file: 'version: 1\njobSources: []\n' });
    await host.start();
    expect(host.report().notifiers.instances).toEqual([{
      instance: { name: 'grok-bot', plugin: 'grokbot-routine', options: { envFile: join(dir, 'grokbot-webhook.env') } },
      detection: { status: 'needs-setup', reason: expect.stringContaining('grokbot-webhook.env'), command: expect.stringContaining('GROKBOT_WEBHOOK_URL') },
      active: 'grokbot-routine',
    }]);
  });

  it('notifiers: [] → none', async () => {
    const { host } = start({ file: 'version: 1\nnotifiers: []\n' });
    await host.start();
    expect(host.report().notifiers.instances).toEqual([]);
    expect(host.notifiers()).toEqual([]);
  });

  it('built from plugins.yaml, started with the event feed under their instance names, stopped once', async () => {
    const { host } = start({ file: 'version: 1\nnotifiers: [ { name: one, plugin: recorder }, { name: two, plugin: recorder } ]\n' });
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
    ['unknown plugin', '{ name: x, plugin: no-such-notifier }', /unknown notifier plugin no-such-notifier/],
    ['invalid options', '{ name: x, plugin: recorder, options: { fail: maybe } }', /fail/],
    ['a router plugin named as a notifier', '{ name: x, plugin: pass-through }', /unknown notifier plugin pass-through/],
    ['unavailable', '{ name: x, plugin: never-here }', /not on this machine/],
    ['create throws', '{ name: x, plugin: recorder, options: { fail: create } }', /cannot create: create boom/],
    ['start throws', '{ name: x, plugin: recorder, options: { fail: start } }', /cannot start: start boom/],
  ])('%s: dropped with the reason in the report; the others still run; never a boot failure', async (_n, entry, why) => {
    const { host } = start({ file: `version: 1\nnotifiers: [ ${entry}, { name: ok, plugin: recorder } ]\n` });
    await host.start();
    host.startNotifiers(feed());
    expect(host.notifiers().map((n) => n.name)).toEqual(['ok']);
    expect(host.report().notifiers.instances.map((i) => [i.instance.name, i.active])).toEqual([['x', null], ['ok', 'recorder']]);
    expect(host.report().notifiers.instances[0]!.reason).toMatch(why);
  });

  it('two notifiers with one name are refused', async () => {
    const { host } = start({ file: 'version: 1\nnotifiers: [ { name: n, plugin: recorder }, { name: n, plugin: recorder } ]\n' });
    await host.start();
    expect(host.report().config.error).toMatch(/notifiers.*twice/);
  });

  it('a restart role: an edit shows changed — restart pending; the running notifiers stay', async () => {
    const { host, pluginsFile } = start({ file: 'version: 1\nnotifiers: []\n' });
    await host.start();
    writeFileSync(pluginsFile, 'version: 1\nnotifiers: [ { name: one, plugin: recorder } ]\n', { mode: 0o600 });
    await host.reload();
    expect(host.report().notifiers.pending).toEqual({ status: 'changed — restart pending', instances: [{ name: 'one', plugin: 'recorder', options: {} }] });
    expect(host.notifiers()).toEqual([]);
  });
});

describe('grokbot-routine detection: its env file only, never the Grok Bot binary', () => {
  const entry = (file: string) => `version: 1\nnotifiers: [ { name: grok-bot, plugin: grokbot-routine, options: { envFile: ${file} } } ]\n`;

  it('the env file exists and is readable → available; nothing is run', async () => {
    const ran: string[] = [];
    const kit = fakeKit({
      exists: async () => true, readable: async () => true,
      which: async (b) => { ran.push(`which ${b}`); return undefined; },
      version: async (b) => { ran.push(`version ${b}`); return undefined; },
      succeeds: async (b) => { ran.push(`succeeds ${b}`); return false; },
    });
    const { host } = start({ file: entry('/x/grokbot-webhook.env'), kit });
    await host.start();
    expect(host.report().notifiers.instances[0]).toMatchObject({ detection: { status: 'available' }, active: 'grokbot-routine' });
    expect(ran.filter((r) => /grok/i.test(r))).toEqual([]);
  });

  it('missing → needs-setup with the file to write; still runs (a file written later applies without a restart)', async () => {
    const { host } = start({ file: entry('/x/g.env'), kit: fakeKit({ exists: async () => false, readable: async () => false }) });
    await host.start();
    expect(host.report().notifiers.instances[0]).toEqual({
      instance: { name: 'grok-bot', plugin: 'grokbot-routine', options: { envFile: '/x/g.env' } },
      detection: { status: 'needs-setup', reason: 'no Grok Bot routine configured: /x/g.env not found', command: expect.stringMatching(/GROKBOT_WEBHOOK_URL=.*GROKBOT_WEBHOOK_KEY=.*\/x\/g\.env/s) },
      active: 'grokbot-routine',
    });
  });

  it('present but unreadable → needs-setup: chmod it', async () => {
    const { host } = start({ file: entry('/x/g.env'), kit: fakeKit({ exists: async () => true, readable: async () => false }) });
    await host.start();
    expect(host.report().notifiers.instances[0]!.detection).toEqual({ status: 'needs-setup', reason: '/x/g.env is not readable', command: 'chmod 600 /x/g.env' });
  });
});
