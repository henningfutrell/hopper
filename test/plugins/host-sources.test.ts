// Phase 5 slice 4: the job-source, machine-source and usage-source roles in the plugin host, built
// at start from plugins.yaml (or the built-in instances when a section is absent). Job and usage
// sources are restart roles: a later edit shows `changed — restart pending`. The machine source
// applies an options edit live (issue #18); another instance still waits for a restart. Detection never makes a paid
// call: github-gh asks `gh auth status`, github-app looks for its app file.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageSource } from '../../src/domain/ports.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { createPluginHost, type PluginHost } from '../../src/plugins/index.ts';
import type { DetectionKit, PluginDefinition } from '../../src/plugins/sdk.ts';
import { fakeKit, fixedClock, useTempDirs } from './support.ts';

const temp = useTempDirs();
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

function start(o: { file?: string; kit?: DetectionKit; executors?: () => string[] } = {}) {
  const dir = temp();
  const pluginsFile = join(dir, 'plugins.yaml');
  if (o.file !== undefined) writeFileSync(pluginsFile, o.file, { mode: 0o600 });
  host = createPluginHost({
    pluginDir: join(dir, 'plugins'), pluginsFile, dataDir: dir, clock: fixedClock,
    logger: { info() {}, warn() {} }, routerMode: () => 'shadow', kit: o.kit ?? fakeKit({ exists: async () => false }),
    builtins: [...BUILTIN_PLUGINS, fixedUsage],
    defaultAnswerer: null,
    defaultAssessor: { name: 'a', plugin: 'always-escalate' },
    defaultExecutors: [{ name: 'test', plugin: 'test' }],
    ...(o.executors ? { machineContext: { executors: o.executors } } : {}),
    intervalMs: 30,
  });
  return { host, pluginsFile, dir };
}

const catalogue = (h: PluginHost, id: string) => h.report().plugins.find((p) => p.id === id);

describe('detection of the job-source plugins', () => {
  it('github-gh: needs-setup with the command when `gh auth status` fails; unavailable without gh; available when logged in', async () => {
    const calls: string[][] = [];
    const { host: a } = start({ kit: fakeKit({ succeeds: async (bin, args) => { calls.push([bin, ...args]); return false; } }) });
    await a.start();
    expect(catalogue(a, 'github-gh')).toMatchObject({ role: 'job-source', builtin: true, detection: { status: 'needs-setup', command: 'gh auth login' } });
    expect(calls).toContainEqual(['gh', 'auth', 'status']);
    a.stop();

    const { host: b } = start({ kit: fakeKit({ which: async (bin) => (bin === 'gh' ? undefined : `/usr/bin/${bin}`) }) });
    await b.start();
    expect(catalogue(b, 'github-gh')!.detection).toEqual({ status: 'unavailable', reason: 'gh not found: gh' });
    b.stop();

    const { host: c } = start({ kit: fakeKit() });
    await c.start();
    expect(catalogue(c, 'github-gh')!.detection).toMatchObject({ status: 'available' });
  });

  it('github-app: needs-setup with the create-github-app command while the app file is missing; available once it exists', async () => {
    const { host: a } = start({ kit: fakeKit({ exists: async () => false }) });
    await a.start();
    expect(catalogue(a, 'github-app')!.detection).toEqual({
      status: 'needs-setup', reason: expect.stringMatching(/no GitHub App configured/),
      command: 'bash ~/.local/lib/job-hopper/scripts/create-github-app.sh',
    });
    a.stop();
    const { host: b } = start({ kit: fakeKit({ exists: async () => true }) });
    await b.start();
    expect(catalogue(b, 'github-app')!.detection).toMatchObject({ status: 'available' });
  });
});

describe('job-source instances', () => {
  it('built from plugins.yaml under their instance names; a source that needs setup is still built (it waits), and says so', async () => {
    const { host } = start({ file: [
      'version: 1',
      'jobSources:',
      '  - { name: github, plugin: github-gh, options: { enabled: true, repos: [o/r] } }',
      '  - { name: github-app, plugin: github-app, options: { appFile: /nonexistent/jh/github-app.json } }',
    ].join('\n') });
    await host.start();
    const built = host.jobSources();
    expect(built.map((b) => b.spec.name)).toEqual(['github', 'github-app']);
    for (const b of built) {
      expect(b.instance && 'source' in b.instance && b.instance.source.name).toBe(b.spec.name);
    }
    const gh = built[0]!.instance!;
    expect('source' in gh && gh.pollMs).toBe(60_000);
    expect(host.report().jobSources.instances).toEqual([
      { instance: { name: 'github', plugin: 'github-gh', options: { enabled: true, repos: ['o/r'] } }, detection: { status: 'available', detail: expect.any(String) }, active: 'github-gh' },
      { instance: expect.objectContaining({ name: 'github-app' }), detection: expect.objectContaining({ status: 'needs-setup' }), active: 'github-app' },
    ]);
  });

  it('enabled: false is a disabled instance (listed, never run)', async () => {
    const { host } = start({ file: 'version: 1\njobSources: [ { name: github, plugin: github-gh, options: { enabled: false } } ]\n' });
    await host.start();
    expect(host.jobSources()[0]!.instance).toMatchObject({ disabled: { kind: 'github' } });
  });

  it.each([
    ['unknown plugin', '{ name: x, plugin: no-such-source }', /unknown job-source plugin no-such-source/],
    ['invalid options', '{ name: x, plugin: github-gh, options: { pollSeconds: -5 } }', /pollSeconds/],
    ['an executor plugin named as a source', '{ name: x, plugin: test }', /unknown job-source plugin test/],
  ])('%s: dropped with the reason', async (_n, entry, why) => {
    const { host } = start({ file: `version: 1\njobSources: [ ${entry} ]\n` });
    await host.start();
    const [x] = host.jobSources();
    expect(x!.instance).toBeUndefined();
    expect(x!.reason).toMatch(why);
    expect(host.report().jobSources.instances[0]).toMatchObject({ instance: { name: 'x' }, active: null, reason: expect.stringMatching(why) });
  });

  it('gh not installed: dropped (unavailable is not needs-setup)', async () => {
    const { host } = start({ file: 'version: 1\njobSources: [ { name: github, plugin: github-gh, options: { bin: /nonexistent/gh } } ]\n', kit: fakeKit({ which: async () => undefined }) });
    await host.start();
    expect(host.jobSources()[0]).toMatchObject({ plugin: null, reason: 'gh not found: /nonexistent/gh' });
  });

  it('two sources with one name are refused (sync state is keyed by the name)', async () => {
    const { host } = start({ file: 'version: 1\njobSources: [ { name: g, plugin: github-gh }, { name: g, plugin: github-app } ]\n' });
    await host.start();
    expect(host.report().config.error).toMatch(/jobSources.*twice|twice/);
  });

  it('no jobSources section: the built-in instances — github disabled, github-app waiting for the app file beside plugins.yaml', async () => {
    const { host, dir } = start({ file: 'version: 1\n' });
    await host.start();
    expect(host.report().jobSources.instances.map((i) => i.instance)).toEqual([
      { name: 'github', plugin: 'github-gh', options: { enabled: false, bin: 'gh', appFile: join(dir, 'github-app.json') } },
      { name: 'github-app', plugin: 'github-app', options: { appFile: join(dir, 'github-app.json') } },
    ]);
  });

  it('a restart role: an edit shows changed — restart pending; the built sources stay', async () => {
    const { host, pluginsFile } = start({ file: 'version: 1\njobSources: []\n' });
    await host.start();
    writeFileSync(pluginsFile, 'version: 1\njobSources: [ { name: github, plugin: github-gh } ]\n', { mode: 0o600 });
    await host.reload();
    expect(host.report().jobSources.pending).toEqual({ status: 'changed — restart pending', instances: [{ name: 'github', plugin: 'github-gh', options: {} }] });
    expect(host.jobSources()).toEqual([]);
  });
});

describe('the machine-source role', () => {
  it('local: one machine named after the instance, lanes from its option, the executors the context names', async () => {
    const { host } = start({ file: 'version: 1\nmachines: { name: local, plugin: local, options: { lanes: 2 } }\n', executors: () => ['test', 'scripted'] });
    await host.start();
    expect(await host.machines().list()).toEqual([expect.objectContaining({ id: 'local', maxLanes: 2, online: true, executors: ['test', 'scripted'] })]);
    expect(host.report().machines.instances).toEqual([
      { instance: { name: 'local', plugin: 'local', options: { lanes: 2 } }, detection: { status: 'available' }, active: 'local' },
    ]);
  });

  it('no machines section: local with 4 lanes', async () => {
    const { host } = start({ file: 'version: 1\n' });
    await host.start();
    expect(await host.machines().list()).toEqual([expect.objectContaining({ id: 'local', maxLanes: 4 })]);
  });

  it('a machine source that cannot run: no machine at all (every job held), never a guessed one — with the reason', async () => {
    const { host } = start({ file: 'version: 1\nmachines: { name: local, plugin: local, options: { lanes: -1 } }\n' });
    await host.start();
    expect(await host.machines().list()).toEqual([]);
    expect(host.report().machines.instances[0]).toMatchObject({ active: null, reason: expect.stringMatching(/lanes/) });
  });

  it('a lanes edit applies live (issue #18): same instance, new options, no restart pending', async () => {
    const { host, pluginsFile } = start({ file: 'version: 1\nmachines: { name: local, plugin: local, options: { lanes: 2 } }\n' });
    await host.start();
    const machines = host.machines();
    writeFileSync(pluginsFile, 'version: 1\nmachines: { name: local, plugin: local, options: { lanes: 3 } }\n', { mode: 0o600 });
    await host.reload();
    expect(host.report().machines.pending).toBeUndefined();
    expect(host.report().machines.instances[0]!.instance.options).toEqual({ lanes: 3 });
    expect((await machines.list())[0]!.maxLanes).toBe(3);
  });

  it('another instance name or plugin still waits for a restart: lanes are stored under the machine id', async () => {
    const { host, pluginsFile } = start({ file: 'version: 1\nmachines: { name: local, plugin: local, options: { lanes: 2 } }\n' });
    await host.start();
    writeFileSync(pluginsFile, 'version: 1\nmachines: { name: server, plugin: local, options: { lanes: 3 } }\n', { mode: 0o600 });
    await host.reload();
    expect(host.report().machines.pending).toEqual({ status: 'changed — restart pending', instances: [{ name: 'server', plugin: 'local', options: { lanes: 3 } }] });
    expect((await host.machines().list())[0]).toMatchObject({ id: 'local', maxLanes: 2 });
  });
});

describe('attached machines in the host (issue #18)', () => {
  it('attachedMachines() follows plugins.yaml: added, changed and removed without a restart', async () => {
    const { host, pluginsFile } = start({ file: 'version: 1\n' });
    await host.start();
    expect(host.attachedMachines()).toEqual([]);
    writeFileSync(pluginsFile, 'version: 1\nattachedMachines:\n  - { name: laptop, ssh: laptop, lanes: 2, herdrBin: /h/herdr }\n', { mode: 0o600 });
    await host.reload();
    expect(host.attachedMachines()).toEqual([{ name: 'laptop', ssh: 'laptop', lanes: 2, herdrBin: '/h/herdr', session: 'job-hopper', executors: ['herdr-claude'] }]);
    writeFileSync(pluginsFile, 'version: 1\nattachedMachines: []\n', { mode: 0o600 });
    await host.reload();
    expect(host.attachedMachines()).toEqual([]);
  });

  it('an invalid plugins.yaml keeps the last good attached machines', async () => {
    const { host, pluginsFile } = start({ file: 'version: 1\nattachedMachines:\n  - { name: laptop, ssh: laptop, lanes: 2 }\n' });
    await host.start();
    writeFileSync(pluginsFile, 'version: 1\nattachedMachines:\n  - { name: laptop, ssh: -oProxy, lanes: 2 }\n', { mode: 0o600 });
    await host.reload();
    expect(host.attachedMachines().map((m) => m.ssh)).toEqual(['laptop']);
  });
});

describe('the usage-source role', () => {
  it('none built in: no usage sources unless plugins.yaml names one', async () => {
    const { host } = start({ file: 'version: 1\n' });
    await host.start();
    expect(host.usageSources()).toEqual([]);
    expect(BUILTIN_PLUGINS.filter((p) => p.role === 'usage-source')).toEqual([]);
  });

  it('a usage plugin named in plugins.yaml is polled under its instance name; an unknown one is dropped with the reason', async () => {
    const { host } = start({ file: 'version: 1\nusageSources: [ { name: budget, plugin: fixed-usage, options: { used: 42 } }, { name: nope, plugin: no-such-usage } ]\n' });
    await host.start();
    const [u] = host.usageSources();
    expect(u!.name).toBe('budget');
    expect(await u!.poll()).toEqual([expect.objectContaining({ used: 42 })]);
    expect(host.report().usageSources.instances.map((i) => [i.instance.name, i.active])).toEqual([['budget', 'fixed-usage'], ['nope', null]]);
  });
});
