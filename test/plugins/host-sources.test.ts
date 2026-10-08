// Phase 5 slice 4: the job-source, machine-source and usage-source roles in the plugin host, built
// at start from the plugins config (or the built-in instances when a section is absent). All three
// follow the plugins config live: the machine sources — this machine and every attached one (issue
// #74) — since issue #18, the job and usage sources since issue #356. Detection
// never makes a paid call: github-app looks for the app's identity and key in the environment,
// claude-plan `which`es claude.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineSource, UsageSource } from '../../src/domain/ports.ts';
import type { AttachedMachine } from '../../src/domain/types.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { createPluginHost, type BuiltJobSource, type PluginHost } from '../../src/plugins/index.ts';
import type { DetectionKit, PluginDefinition } from '../../src/plugins/sdk.ts';
import { PLUGINS } from '../../src/plugins/plugins-config.ts';
import { useTempConfig } from '../support/config.ts';
import { KEYS } from '../support/github-app.ts';
import { fakeKit, fixedClock, useTempDirs } from './support.ts';

const temp = useTempDirs();
const records = useTempConfig();
let host: PluginHost | undefined;
afterEach(() => { host?.stop(); host = undefined; });

/** A usage source reporting one fixed reading. */
const fixedUsage: PluginDefinition<'usage-source'> = {
  id: 'fixed-usage', role: 'usage-source', describe: 'one fixed reading',
  options: (z) => z.object({ used: z.number().default(10) }),
  async detect() { return { status: 'available' }; },
  create(ctx, o): UsageSource {
    return { name: 'fixed-usage', poll: async () => [{ source: 'fixed-usage', used: o.used, limit: 100, unit: '%', at: ctx.clock.now().toISOString() }] };
  },
};

/** A usage source reporting, as its one reading's window, the machine its context finds under `machine` (issue #139). */
const machineUsage: PluginDefinition<'usage-source'> = {
  id: 'machine-usage', role: 'usage-source', describe: 'the machine it finds',
  options: (z) => z.object({ machine: z.string() }),
  async detect() { return { status: 'available' }; },
  create(ctx, o): UsageSource {
    return {
      name: 'machine-usage',
      poll: async () => {
        const m = await ctx.machine(o.machine);
        return [{ source: 'machine-usage', window: m ? `${m.id} ${m.ssh ?? ''} ${m.online}` : 'none', used: 0, limit: 100, unit: '%', at: ctx.clock.now().toISOString() }];
      },
    };
  },
};

/** Each attached machine as a source listing it online, and the machines it was asked for, in order. */
function targets() {
  const asked: AttachedMachine[] = [];
  const target = (m: AttachedMachine): MachineSource => {
    asked.push(m);
    return { list: async () => [{ id: m.name, label: m.label ?? m.name, maxLanes: m.lanes, online: true, executors: [...m.executors] }] };
  };
  return { asked, target };
}

function start(o: { file?: object; kit?: DetectionKit; executors?: () => string[]; target?: (m: AttachedMachine) => MachineSource; jobSourcesChanged?: (built: BuiltJobSource[]) => void } = {}) {
  const dir = temp();
  const config = records();
  if (o.file !== undefined) config.set(PLUGINS, o.file);
  host = createPluginHost({
    pluginDir: join(dir, 'plugins'), config, dataDir: dir, clock: fixedClock,
    logger: { info() {}, warn() {} }, kit: o.kit ?? fakeKit({ exists: async () => false }),
    builtins: [...BUILTIN_PLUGINS, fixedUsage, machineUsage],
    defaultLevels: [],
    defaultExecutors: [{ name: 'test', plugin: 'test' }],
    machineContext: { ...(o.executors ? { executors: o.executors } : {}), ...(o.target ? { target: o.target } : {}) },
    intervalMs: 30,
    ...(o.jobSourcesChanged ? { jobSourcesChanged: o.jobSourcesChanged } : {}),
  });
  return { host, config, dir };
}

const catalogue = (h: PluginHost, id: string) => h.report().plugins.find((p) => p.id === id);

describe('detection of the job-source plugins', () => {
  const appFile = { version: 1, jobSources: [{ name: 'github-app', plugin: 'github-app', options: { appId: 4242, slug: 'hopper-test' } }] };
  const detection = (h: PluginHost) => h.report().jobSources.instances[0]!.detection;

  it('github-app: needs-setup with the create-github-app command while the key variable is unset; available once it is set', async () => {
    const { host: a } = start({ file: appFile, kit: fakeKit() });
    await a.start();
    expect(detection(a)).toEqual({
      status: 'needs-setup', reason: expect.stringMatching(/GITHUB_APP_PRIVATE_KEY not set/),
      command: expect.stringContaining('scripts/create-github-app.sh'),
    });
    a.stop();
    const { host: b } = start({ file: appFile, kit: fakeKit({ env: (n) => (n === 'GITHUB_APP_PRIVATE_KEY' ? KEYS.privateKey : undefined) }) });
    await b.start();
    expect(detection(b)).toMatchObject({ status: 'available' });
  });

  it.each(['github-app'])('%s in the catalogue: needs-setup until its app is set up; no authors to name (issue #387)', async (id) => {
    const { host } = start({ kit: fakeKit() });
    await host.start();
    expect(catalogue(host, id)!.detection).toMatchObject({ status: 'needs-setup', reason: 'no GitHub App configured' });
  });
});

describe('job-source instances', () => {
  it('built from the plugins config under their instance names; a source that needs setup is still built (it waits), and says so', async () => {
    const { host } = start({ file: {
      version: 1,
      jobSources: [
        { name: 'github', plugin: 'github-account', options: { enabled: true } },
        { name: 'github-app', plugin: 'github-app', options: { label: 'hopper' } },
      ],
    } });
    await host.start();
    const built = host.jobSources();
    expect(built.map((b) => b.spec.name)).toEqual(['github', 'github-app']);
    for (const b of built) {
      expect(b.instance && 'source' in b.instance && b.instance.source.name).toBe(b.spec.name);
    }
    const gh = built[0]!.instance!;
    expect('source' in gh && gh.pollMs).toBe(60_000);
    expect(host.report().jobSources.instances).toEqual([
      { instance: { name: 'github', plugin: 'github-account', options: { enabled: true } }, detection: { status: 'available', detail: expect.any(String) }, active: 'github-account' },
      { instance: expect.objectContaining({ name: 'github-app' }), detection: expect.objectContaining({ status: 'needs-setup' }), active: 'github-app' },
    ]);
  });

  it('enabled: false is a disabled instance (listed, never run)', async () => {
    const { host } = start({ file: { version: 1, jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: false } }] } });
    await host.start();
    expect(host.jobSources()[0]!.instance).toMatchObject({ disabled: { kind: 'github-account' } });
  });

  it.each([
    ['unknown plugin', { name: 'x', plugin: 'no-such-source' }, /unknown job-source plugin no-such-source/],
    ['invalid options', { name: 'x', plugin: 'github-account', options: { pollSeconds: -5 } }, /pollSeconds/],
    ['an executor plugin named as a source', { name: 'x', plugin: 'test' }, /unknown job-source plugin test/],
  ])('%s: dropped with the reason', async (_n, entry, why) => {
    const { host } = start({ file: { version: 1, jobSources: [entry] } });
    await host.start();
    const [x] = host.jobSources();
    expect(x!.instance).toBeUndefined();
    expect(x!.reason).toMatch(why);
    expect(host.report().jobSources.instances[0]).toMatchObject({ instance: { name: 'x' }, active: null, reason: expect.stringMatching(why) });
  });

  it('two sources with one name are refused (sync state is keyed by the name)', async () => {
    const { host } = start({ file: { version: 1, jobSources: [{ name: 'g', plugin: 'github-account' }, { name: 'g', plugin: 'github-app' }] } });
    await host.start();
    expect(host.report().config.error).toMatch(/jobSources.*twice|twice/);
  });

  it('no jobSources section: the built-in instance — the connected GitHub account\'s (#214, #359), which runs and waits for a connection; the app-as-itself source is an admin\'s to add', async () => {
    const { host } = start({ file: { version: 1 } });
    await host.start();
    expect(host.report().jobSources.instances.map((i) => i.instance)).toEqual([{ name: 'github-account', plugin: 'github-account' }]);
    expect(host.report().jobSources.instances[0]).toMatchObject({ active: 'github-account' });
  });

  it('live (issue #356): an added source is built at once, an unchanged one kept, a changed one rebuilt, a removed one goes; the host says so', async () => {
    const seen: string[][] = [];
    const { host, config } = start({ file: { version: 1, jobSources: [{ name: 'one', plugin: 'github-account', options: { label: 'hopper' } }] }, kit: fakeKit(), jobSourcesChanged: (b) => seen.push(b.map((x) => x.spec.name)) });
    await host.start();
    const [one] = host.jobSources();
    config.set(PLUGINS, { version: 1, jobSources: [{ name: 'one', plugin: 'github-account', options: { label: 'hopper' } }, { name: 'two', plugin: 'github-account', options: { label: 'hopper' } }] });
    await host.reload();
    expect(host.jobSources().map((b) => b.spec.name)).toEqual(['one', 'two']);
    expect(host.jobSources()[0]).toBe(one);
    expect(host.report().jobSources).toEqual({ instances: [expect.objectContaining({ active: 'github-account' }), expect.objectContaining({ active: 'github-account' })] });
    config.set(PLUGINS, { version: 1, jobSources: [{ name: 'one', plugin: 'github-account', options: { label: 'work' } }] });
    await host.reload();
    expect(host.jobSources().map((b) => b.spec.options)).toEqual([{ label: 'work' }]);
    expect(host.jobSources()[0]).not.toBe(one);
    expect(seen).toEqual([['one', 'two'], ['one']]);
  });
});

describe('the machine-source role', () => {
  it('local: one machine named after the instance, lanes from its option, the executors the context names', async () => {
    const { host } = start({ file: { version: 1, machines: [{ name: 'local', plugin: 'local', options: { lanes: 2 } }] }, executors: () => ['test', 'scripted'] });
    await host.start();
    expect(await host.machines().list()).toEqual([expect.objectContaining({ id: 'local', maxLanes: 2, online: true, executors: ['test', 'scripted'] })]);
    expect(host.report().machines.instances).toEqual([
      { instance: { name: 'local', plugin: 'local', options: { lanes: 2 } }, detection: { status: 'available' }, active: 'local' },
    ]);
  });

  it('local: its reserved lanes reach its machine (issue #372)', async () => {
    const { host } = start({ file: { version: 1, machines: [{ name: 'local', plugin: 'local', options: { lanes: 4, reservedLanes: 1 } }] } });
    await host.start();
    expect(await host.machines().list()).toEqual([expect.objectContaining({ id: 'local', maxLanes: 4, reservedLanes: 1 })]);
  });

  it('no machines section: local with 4 lanes', async () => {
    const { host } = start({ file: { version: 1 } });
    await host.start();
    expect(await host.machines().list()).toEqual([expect.objectContaining({ id: 'local', maxLanes: 4 })]);
  });

  it('a machine source that cannot run lists no machine, never a guessed one — with the reason; the others still run', async () => {
    const t = targets();
    const { host } = start({
      file: { version: 1, machines: [{ name: 'local', plugin: 'local', options: { lanes: -1 } }, { name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', lanes: 1 } }] },
      target: t.target,
    });
    await host.start();
    expect((await host.machines().list()).map((m) => m.id)).toEqual(['laptop']);
    expect(host.report().machines.instances[0]).toMatchObject({ active: null, reason: expect.stringMatching(/lanes/) });
  });

  it('a lanes edit applies live (issue #18): same instance, new options, no restart pending', async () => {
    const { host, config } = start({ file: { version: 1, machines: [{ name: 'local', plugin: 'local', options: { lanes: 2 } }] } });
    await host.start();
    const machines = host.machines();
    config.set(PLUGINS, { version: 1, machines: [{ name: 'local', plugin: 'local', options: { lanes: 3 } }] });
    await host.reload();
    expect(host.report().machines.instances[0]!.instance.options).toEqual({ lanes: 3 });
    expect((await machines.list())[0]!.maxLanes).toBe(3);
  });

  it('another instance name applies live too: the machines are what the plugins config names now', async () => {
    const { host, config } = start({ file: { version: 1, machines: [{ name: 'local', plugin: 'local', options: { lanes: 2 } }] } });
    await host.start();
    config.set(PLUGINS, { version: 1, machines: [{ name: 'server', plugin: 'local', options: { lanes: 3 } }] });
    await host.reload();
    expect(await host.machines().list()).toEqual([expect.objectContaining({ id: 'server', maxLanes: 3 })]);
  });
});

describe('attached machines in the host (issues #18, #74)', () => {
  it('an attached machine is a machine-source instance: added, changed and removed without a restart', async () => {
    const t = targets();
    const { host, config } = start({ file: { version: 1 }, target: t.target });
    await host.start();
    expect(host.targets()).toEqual([]);
    config.set(PLUGINS, { version: 1, machines: [{ name: 'local', plugin: 'local' }, { name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', lanes: 2 } }] });
    await host.reload();
    const laptop = { name: 'laptop', ssh: 'laptop', lanes: 2, herdr: true, session: 'hopper', executors: ['herdr-claude'] };
    expect(host.targets()).toEqual([laptop]);
    expect(t.asked).toEqual([laptop]);
    expect((await host.machines().list()).map((m) => `${m.id}:${m.maxLanes}`)).toEqual(['local:4', 'laptop:2']);
    expect(host.machineIds()).toEqual(['local', 'laptop']);
    config.set(PLUGINS, { version: 1, machines: [{ name: 'local', plugin: 'local' }] });
    await host.reload();
    expect(host.targets()).toEqual([]);
    expect((await host.machines().list()).map((m) => m.id)).toEqual(['local']);
  });

  it('an attached machine whose options are invalid cannot run, with the reason; it is no target', async () => {
    const t = targets();
    const { host } = start({ file: { version: 1, machines: [{ name: 'local', plugin: 'local' }, { name: 'laptop', plugin: 'ssh', options: { ssh: '-oProxy', lanes: 2 } }] }, target: t.target });
    await host.start();
    expect(host.targets()).toEqual([]);
    expect(t.asked).toEqual([]);
    expect(host.report().machines.instances[1]).toMatchObject({ active: null, reason: expect.stringMatching(/ssh must be a destination/) });
  });

  it('an invalid plugins config keeps the last good machines', async () => {
    const t = targets();
    const { host, config } = start({ file: { version: 1, machines: [{ name: 'local', plugin: 'local' }, { name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', lanes: 2 } }] }, target: t.target });
    await host.start();
    config.set(PLUGINS, { version: 1, machines: { name: 'laptop' } });
    await host.reload();
    expect(host.targets().map((m) => m.name)).toEqual(['laptop']);
    expect((await host.machines().list()).map((m) => m.id)).toEqual(['local', 'laptop']);
  });
});

describe('the usage-source role', () => {
  it('built in: claude-plan and command-usage; no section means the built-in claude instance, `usageSources: []` means none', async () => {
    expect(BUILTIN_PLUGINS.filter((p) => p.role === 'usage-source').map((p) => p.id)).toEqual(['claude-plan', 'command-usage']);
    const absent = start({ file: { version: 1 } }).host;
    await absent.start();
    expect(absent.report().usageSources.instances.map((i) => [i.instance.name, i.instance.plugin, i.active]))
      .toEqual([['claude', 'claude-plan', 'claude-plan']]);
    absent.stop();
    const none = start({ file: { version: 1, usageSources: [] } }).host;
    await none.start();
    expect(none.usageSources()).toEqual([]);
  });

  it('a usage plugin named in the plugins config is polled under its instance name; an unknown one is dropped with the reason', async () => {
    const { host } = start({ file: { version: 1, usageSources: [{ name: 'budget', plugin: 'fixed-usage', options: { used: 42 } }, { name: 'nope', plugin: 'no-such-usage' }] } });
    await host.start();
    const [u] = host.usageSources();
    expect(u!.name).toBe('budget');
    expect(await u!.poll()).toEqual([expect.objectContaining({ used: 42 })]);
    expect(host.report().usageSources.instances.map((i) => [i.instance.name, i.active])).toEqual([['budget', 'fixed-usage'], ['nope', null]]);
  });

  it('a usage source finds a machine by its id, as the machine sources list it now (issue #139)', async () => {
    const t = targets();
    const { host, config } = start({
      file: { version: 1, machines: [{ name: 'local', plugin: 'local' }, { name: 'laptop', plugin: 'ssh', options: { ssh: 'laptop', lanes: 1 } }], usageSources: [{ name: 'on-laptop', plugin: 'machine-usage', options: { machine: 'laptop' } }] },
      target: (m) => ({ list: async () => [{ ...(await t.target(m).list())[0]!, ssh: 'laptop' }] }),
    });
    await host.start();
    const [u] = host.usageSources();
    expect((await u!.poll())[0]!.window).toBe('laptop laptop true');
    config.set(PLUGINS, { version: 1, machines: [{ name: 'local', plugin: 'local' }], usageSources: [{ name: 'on-laptop', plugin: 'machine-usage', options: { machine: 'laptop' } }] });
    await host.reload();
    expect((await u!.poll())[0]!.window).toBe('none');
  });
});
