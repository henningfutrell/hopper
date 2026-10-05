// Phase 5 slice 4: the job-source, machine-source and usage-source roles in the plugin host, built
// at start from plugins.yaml (or the built-in instances when a section is absent). Job and usage
// sources are restart roles: a later edit shows `changed — restart pending`. The machine sources —
// this machine and every attached one (issue #74) — follow plugins.yaml live (issue #18). Detection
// never makes a paid call: github-gh asks `gh auth status`, github-app looks for the app's identity and key in the environment,
// claude-plan `which`es claude.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MachineSource, UsageSource } from '../../src/domain/ports.ts';
import type { AttachedMachine } from '../../src/domain/types.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import { createPluginHost, type PluginHost } from '../../src/plugins/index.ts';
import type { DetectionKit, PluginDefinition } from '../../src/plugins/sdk.ts';
import { PLUGINS } from '../../src/plugins/plugins-file.ts';
import { useTempDocuments } from '../support/documents.ts';
import { KEYS } from '../support/github-app.ts';
import { fakeKit, fixedClock, useTempDirs } from './support.ts';

const temp = useTempDirs();
const docs = useTempDocuments();
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

/** Each attached machine as a source listing it online, and the machines it was asked for, in order. */
function targets() {
  const asked: AttachedMachine[] = [];
  const target = (m: AttachedMachine): MachineSource => {
    asked.push(m);
    return { list: async () => [{ id: m.name, label: m.label ?? m.name, maxLanes: m.lanes, online: true, executors: [...m.executors] }] };
  };
  return { asked, target };
}

function start(o: { file?: string; kit?: DetectionKit; executors?: () => string[]; target?: (m: AttachedMachine) => MachineSource } = {}) {
  const dir = temp();
  const documents = docs();
  if (o.file !== undefined) documents.set(PLUGINS, o.file);
  host = createPluginHost({
    pluginDir: join(dir, 'plugins'), documents, dataDir: dir, clock: fixedClock,
    logger: { info() {}, warn() {} }, routerMode: () => 'shadow', kit: o.kit ?? fakeKit({ exists: async () => false }),
    builtins: [...BUILTIN_PLUGINS, fixedUsage],
    defaultAnswerer: null,
    defaultAssessor: { name: 'a', plugin: 'always-escalate' },
    defaultExecutors: [{ name: 'test', plugin: 'test' }],
    machineContext: { ...(o.executors ? { executors: o.executors } : {}), ...(o.target ? { target: o.target } : {}) },
    intervalMs: 30,
  });
  return { host, documents, dir };
}

const catalogue = (h: PluginHost, id: string) => h.report().plugins.find((p) => p.id === id);

describe('detection of the job-source plugins', () => {
  const ghFile = 'version: 1\njobSources: [ { name: github, plugin: github-gh, options: { authors: [owner] } } ]\n';
  const appFile = 'version: 1\njobSources: [ { name: github-app, plugin: github-app, options: { appId: 4242, slug: hopper-test, authors: [owner] } } ]\n';
  const detection = (h: PluginHost) => h.report().jobSources.instances[0]!.detection;

  it('github-gh: needs-setup with the command when `gh auth status` fails; unavailable without gh; available when logged in', async () => {
    const calls: string[][] = [];
    const { host: a } = start({ file: ghFile, kit: fakeKit({ succeeds: async (bin, args) => { calls.push([bin, ...args]); return false; } }) });
    await a.start();
    expect(detection(a)).toMatchObject({ status: 'needs-setup', command: 'gh auth login' });
    expect(calls).toContainEqual(['gh', 'auth', 'status']);
    a.stop();

    const { host: b } = start({ file: ghFile, kit: fakeKit({ which: async (bin) => (bin === 'gh' ? undefined : `/usr/bin/${bin}`) }) });
    await b.start();
    expect(detection(b)).toEqual({ status: 'unavailable', reason: 'gh not found: gh' });
    b.stop();

    const { host: c } = start({ file: ghFile, kit: fakeKit() });
    await c.start();
    expect(detection(c)).toMatchObject({ status: 'available' });
  });

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

  it.each(['github-gh', 'github-app'])('%s in the catalogue: needs-setup until plugins.yaml names its authors (no default allowlist)', async (id) => {
    const { host } = start({ kit: fakeKit() });
    await host.start();
    expect(catalogue(host, id)!.detection).toMatchObject({ status: 'needs-setup', reason: expect.stringMatching(/authors/) });
  });
});

describe('job-source instances', () => {
  it('built from plugins.yaml under their instance names; a source that needs setup is still built (it waits), and says so', async () => {
    const { host } = start({ file: [
      'version: 1',
      'jobSources:',
      '  - { name: github, plugin: github-gh, options: { enabled: true, repos: [o/r], authors: [owner] } }',
      '  - { name: github-app, plugin: github-app, options: { authors: [owner] } }',
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
      { instance: { name: 'github', plugin: 'github-gh', options: { enabled: true, repos: ['o/r'], authors: ['owner'] } }, detection: { status: 'available', detail: expect.any(String) }, active: 'github-gh' },
      { instance: expect.objectContaining({ name: 'github-app' }), detection: expect.objectContaining({ status: 'needs-setup' }), active: 'github-app' },
    ]);
  });

  it('enabled: false is a disabled instance (listed, never run)', async () => {
    const { host } = start({ file: 'version: 1\njobSources: [ { name: github, plugin: github-gh, options: { enabled: false, authors: [owner] } } ]\n' });
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
    const { host } = start({ file: 'version: 1\njobSources: [ { name: github, plugin: github-gh, options: { bin: /nonexistent/gh, authors: [owner] } } ]\n', kit: fakeKit({ which: async () => undefined }) });
    await host.start();
    expect(host.jobSources()[0]).toMatchObject({ plugin: null, reason: 'gh not found: /nonexistent/gh' });
  });

  it('two sources with one name are refused (sync state is keyed by the name)', async () => {
    const { host } = start({ file: 'version: 1\njobSources: [ { name: g, plugin: github-gh }, { name: g, plugin: github-app } ]\n' });
    await host.start();
    expect(host.report().config.error).toMatch(/jobSources.*twice|twice/);
  });

  it('no jobSources section: the built-in instances — github on auto (the gh CLI, #108), github-app with no identity or key; neither runs until authors are set', async () => {
    const { host } = start({ file: 'version: 1\n' });
    await host.start();
    expect(host.report().jobSources.instances.map((i) => i.instance)).toEqual([
      { name: 'github', plugin: 'github-gh', options: { enabled: 'auto' } },
      { name: 'github-app', plugin: 'github-app' },
    ]);
    for (const i of host.report().jobSources.instances) expect(i).toMatchObject({ active: null, reason: expect.stringMatching(/authors/) });
  });

  it('a restart role: an edit shows changed — restart pending; the built sources stay', async () => {
    const { host, documents } = start({ file: 'version: 1\njobSources: []\n' });
    await host.start();
    documents.set(PLUGINS, 'version: 1\njobSources: [ { name: github, plugin: github-gh } ]\n');
    await host.reload();
    expect(host.report().jobSources.pending).toEqual({ status: 'changed — restart pending', instances: [{ name: 'github', plugin: 'github-gh', options: {} }] });
    expect(host.jobSources()).toEqual([]);
  });
});

describe('the machine-source role', () => {
  it('local: one machine named after the instance, lanes from its option, the executors the context names', async () => {
    const { host } = start({ file: 'version: 1\nmachines: [ { name: local, plugin: local, options: { lanes: 2 } } ]\n', executors: () => ['test', 'scripted'] });
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

  it('a machine source that cannot run lists no machine, never a guessed one — with the reason; the others still run', async () => {
    const t = targets();
    const { host } = start({
      file: 'version: 1\nmachines:\n  - { name: local, plugin: local, options: { lanes: -1 } }\n  - { name: laptop, plugin: ssh, options: { ssh: laptop, lanes: 1 } }\n',
      target: t.target,
    });
    await host.start();
    expect((await host.machines().list()).map((m) => m.id)).toEqual(['laptop']);
    expect(host.report().machines.instances[0]).toMatchObject({ active: null, reason: expect.stringMatching(/lanes/) });
  });

  it('a lanes edit applies live (issue #18): same instance, new options, no restart pending', async () => {
    const { host, documents } = start({ file: 'version: 1\nmachines: [ { name: local, plugin: local, options: { lanes: 2 } } ]\n' });
    await host.start();
    const machines = host.machines();
    documents.set(PLUGINS, 'version: 1\nmachines: [ { name: local, plugin: local, options: { lanes: 3 } } ]\n');
    await host.reload();
    expect(host.report().machines.instances[0]!.instance.options).toEqual({ lanes: 3 });
    expect((await machines.list())[0]!.maxLanes).toBe(3);
  });

  it('another instance name applies live too: the machines are what plugins.yaml names now', async () => {
    const { host, documents } = start({ file: 'version: 1\nmachines: [ { name: local, plugin: local, options: { lanes: 2 } } ]\n' });
    await host.start();
    documents.set(PLUGINS, 'version: 1\nmachines: [ { name: server, plugin: local, options: { lanes: 3 } } ]\n');
    await host.reload();
    expect(await host.machines().list()).toEqual([expect.objectContaining({ id: 'server', maxLanes: 3 })]);
  });
});

describe('attached machines in the host (issues #18, #74)', () => {
  it('an attached machine is a machine-source instance: added, changed and removed without a restart', async () => {
    const t = targets();
    const { host, documents } = start({ file: 'version: 1\n', target: t.target });
    await host.start();
    expect(host.targets()).toEqual([]);
    documents.set(PLUGINS, 'version: 1\nmachines:\n  - { name: local, plugin: local }\n  - { name: laptop, plugin: ssh, options: { ssh: laptop, lanes: 2, herdrBin: /h/herdr } }\n');
    await host.reload();
    const laptop = { name: 'laptop', ssh: 'laptop', lanes: 2, herdrBin: '/h/herdr', session: 'hopper', executors: ['herdr-claude'] };
    expect(host.targets()).toEqual([laptop]);
    expect(t.asked).toEqual([laptop]);
    expect((await host.machines().list()).map((m) => `${m.id}:${m.maxLanes}`)).toEqual(['local:4', 'laptop:2']);
    expect(host.machineIds()).toEqual(['local', 'laptop']);
    documents.set(PLUGINS, 'version: 1\nmachines:\n  - { name: local, plugin: local }\n');
    await host.reload();
    expect(host.targets()).toEqual([]);
    expect((await host.machines().list()).map((m) => m.id)).toEqual(['local']);
  });

  it('an attached machine whose options are invalid cannot run, with the reason; it is no target', async () => {
    const t = targets();
    const { host } = start({ file: 'version: 1\nmachines:\n  - { name: local, plugin: local }\n  - { name: laptop, plugin: ssh, options: { ssh: -oProxy, lanes: 2 } }\n', target: t.target });
    await host.start();
    expect(host.targets()).toEqual([]);
    expect(t.asked).toEqual([]);
    expect(host.report().machines.instances[1]).toMatchObject({ active: null, reason: expect.stringMatching(/ssh must be a destination/) });
  });

  it('an invalid plugins.yaml keeps the last good machines', async () => {
    const t = targets();
    const { host, documents } = start({ file: 'version: 1\nmachines:\n  - { name: local, plugin: local }\n  - { name: laptop, plugin: ssh, options: { ssh: laptop, lanes: 2 } }\n', target: t.target });
    await host.start();
    documents.set(PLUGINS, 'version: 1\nmachines: { name: laptop }\n');
    await host.reload();
    expect(host.targets().map((m) => m.name)).toEqual(['laptop']);
    expect((await host.machines().list()).map((m) => m.id)).toEqual(['local', 'laptop']);
  });
});

describe('the usage-source role', () => {
  it('built in: claude-plan; no section means the built-in claude instance, `usageSources: []` means none', async () => {
    expect(BUILTIN_PLUGINS.filter((p) => p.role === 'usage-source').map((p) => p.id)).toEqual(['claude-plan']);
    const absent = start({ file: 'version: 1\n' }).host;
    await absent.start();
    expect(absent.report().usageSources.instances.map((i) => [i.instance.name, i.instance.plugin, i.active]))
      .toEqual([['claude', 'claude-plan', 'claude-plan']]);
    absent.stop();
    const none = start({ file: 'version: 1\nusageSources: []\n' }).host;
    await none.start();
    expect(none.usageSources()).toEqual([]);
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
