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

  it('a fresh install takes jobs through the gh CLI; the App source waits for an App of its own (#108)', () => {
    const { jobSources } = builtinInstances(1000);
    expect(jobSources).toEqual([
      { name: 'github', plugin: 'github-gh', options: { enabled: 'auto' } },
      { name: 'github-app', plugin: 'github-app' },
    ]);
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
});
