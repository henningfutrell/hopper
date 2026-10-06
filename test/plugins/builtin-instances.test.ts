// The built-in instances are written as the plugins config once, into an empty store; an existing
// config is never replaced.
import { describe, expect, it } from 'vitest';
import { builtinInstances, ensurePluginsConfig } from '../../src/plugins/builtin-instances.ts';
import { PLUGINS } from '../../src/plugins/plugins-config.ts';
import { useTempConfig } from '../support/config.ts';

const records = useTempConfig();
const logger = { info() {}, warn() {} };

describe('ensurePluginsConfig', () => {
  it('writes the built-in instances once into an empty store', () => {
    const config = records();
    expect(ensurePluginsConfig({ config, answerTimeoutMs: 1000, logger })).toEqual({ action: 'default' });
    const written = config.read(PLUGINS);
    expect(written).toMatchObject({ version: 1, ...JSON.parse(JSON.stringify(builtinInstances(1000))) });
    expect(ensurePluginsConfig({ config, answerTimeoutMs: 1000, logger })).toEqual({ action: 'kept' });
  });

  it('a fresh install reads the GitHub each user signs in with or connects; gh stays the other way in, and the app-as-itself source is an admin\'s to add (#108, #214)', () => {
    const { jobSources } = builtinInstances(1000);
    expect(jobSources).toEqual([
      { name: 'github-account', plugin: 'github-account' },
      { name: 'github', plugin: 'github-gh', options: { enabled: 'auto' } },
    ]);
  });

  it('the built-in levels are named as levels, not after the model each uses (#209)', () => {
    expect(builtinInstances(1000).escalationLevels.map((l) => [l.name, l.options?.model])).toEqual([['level-1', 'opus'], ['level-2', 'fable']]);
  });

  it('the built-in levels and usage source run on this machine, named as the `local` machine; where this host is no machine they name none (#174)', () => {
    const here = builtinInstances(1000);
    expect(here.escalationLevels.map((l) => l.options?.machine)).toEqual(['local', 'local']);
    expect(here.usageSources.map((u) => u.options?.machine)).toEqual(['local']);
    const container = builtinInstances(1000, false);
    expect([...container.escalationLevels, ...container.usageSources].map((i) => i.options?.machine)).toEqual([undefined, undefined, undefined]);
  });

  it('keeps an existing config untouched', () => {
    const config = records();
    config.set(PLUGINS, { version: 1, notifiers: [] });
    expect(ensurePluginsConfig({ config, answerTimeoutMs: 1000, logger })).toEqual({ action: 'kept' });
    expect(config.read(PLUGINS)).toEqual({ version: 1, notifiers: [] });
  });

  it('a host that is not a machine (the container) lists no machine: an empty store gets `machines: []` (#141)', () => {
    expect(builtinInstances(1000, false).machines).toEqual([]);
    const config = records();
    expect(ensurePluginsConfig({ config, answerTimeoutMs: 1000, localMachine: false, logger })).toEqual({ action: 'default' });
    expect((config.read(PLUGINS) as { machines: unknown }).machines).toEqual([]);
  });

  it('a host that is not a machine removes the `local` instance an earlier boot wrote, and keeps every other machine (#141)', () => {
    const config = records();
    config.set(PLUGINS, {
      version: 1,
      machines: [
        { name: 'local', plugin: 'local', options: { lanes: 4 } },
        { name: 'box', plugin: 'docker', options: { docker: 'box' } },
      ],
      notifiers: [],
    });
    const lines: string[] = [];
    const r = ensurePluginsConfig({ config, answerTimeoutMs: 1000, localMachine: false, logger: { info: (l: string) => lines.push(l), warn() {} } });
    expect(r).toEqual({ action: 'removed-local' });
    expect(config.read(PLUGINS)).toEqual({ version: 1, machines: [{ name: 'box', plugin: 'docker', options: { docker: 'box' } }], notifiers: [] });
    expect(lines.join('\n')).toMatch(/removed the machine `local`/);
    expect(ensurePluginsConfig({ config, answerTimeoutMs: 1000, localMachine: false, logger })).toEqual({ action: 'kept' });
  });

  it('a machine keeps its `local` instance', () => {
    const config = records();
    const value = { version: 1, machines: [{ name: 'local', plugin: 'local', options: { lanes: 2 } }] };
    config.set(PLUGINS, value);
    expect(ensurePluginsConfig({ config, answerTimeoutMs: 1000, logger })).toEqual({ action: 'kept' });
    expect(config.read(PLUGINS)).toEqual(value);
  });

  it('no user gets a herdr session of its own: the built-in herdr-claude instance names none, so it runs in the supervised `hopper` session (#261)', () => {
    expect(builtinInstances(1000).executors.find((e) => e.plugin === 'herdr-claude')).toEqual({ name: 'herdr-claude', plugin: 'herdr-claude' });
  });

  it('removes the `hopper-<id>` session an earlier boot wrote for the user, and keeps a session someone set (#261)', () => {
    const config = records();
    config.set(PLUGINS, {
      version: 1,
      executors: [
        { name: 'herdr-claude', plugin: 'herdr-claude', options: { session: 'hopper-octocat', pollMs: 10 } },
        { name: 'bare', plugin: 'herdr-claude', options: { session: 'hopper-octocat' } },
        { name: 'mine', plugin: 'herdr-claude', options: { session: 'work' } },
      ],
    });
    const lines: string[] = [];
    const r = ensurePluginsConfig({ config, answerTimeoutMs: 1000, userId: 'octocat', logger: { info: (l: string) => lines.push(l), warn() {} } });
    expect(r).toEqual({ action: 'removed-user-session' });
    expect(config.read(PLUGINS)).toEqual({
      version: 1,
      executors: [
        { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10 } },
        { name: 'bare', plugin: 'herdr-claude' },
        { name: 'mine', plugin: 'herdr-claude', options: { session: 'work' } },
      ],
    });
    expect(lines.join('\n')).toMatch(/`hopper-octocat`.*`hopper`/);
    expect(ensurePluginsConfig({ config, answerTimeoutMs: 1000, userId: 'octocat', logger })).toEqual({ action: 'kept' });
  });
});
