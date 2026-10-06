import { describe, expect, it } from 'vitest';
import { loadPluginsConfig } from '../../src/plugins/plugins-config.ts';

describe('the plugins config (router, escalationLevels, executors, jobSources, machines, usageSources)', () => {
  it('absent config → missing, so the caller derives the router', () => {
    expect(loadPluginsConfig(undefined)).toEqual({ missing: true });
  });

  it('reads the router instance', () => {
    const r = loadPluginsConfig({ version: 1, router: { name: 'gate-router', plugin: 'gate-router', options: { python: 'python3' } } });
    expect(r).toEqual({ router: { name: 'gate-router', plugin: 'gate-router', options: { python: 'python3' } }, warnings: [] });
  });

  it('options default to {}', () => {
    expect(loadPluginsConfig({ version: 1, router: { name: 'open', plugin: 'pass-through' } })).toMatchObject({
      router: { name: 'open', plugin: 'pass-through', options: {} },
    });
  });

  it('a config without a router section reads as no router instance', () => {
    expect(loadPluginsConfig({ version: 1 })).toEqual({ warnings: [] });
  });

  it('reads every role section', () => {
    const r = loadPluginsConfig({
      version: 1,
      router: { name: 'gate-router', plugin: 'gate-router' },
      escalationLevels: [{ name: 'opus', plugin: 'claude-cli', options: { model: 'opus' } }, { name: 'fable', plugin: 'claude-cli' }],
      executors: [{ name: 'test', plugin: 'test' }],
      jobSources: [],
      machines: [{ name: 'local', plugin: 'local' }],
      usageSources: [],
      notifiers: [{ name: 'grok-bot', plugin: 'grokbot-routine', options: { envFile: '/x/g.env' } }],
    });
    expect(r).toEqual({
      router: { name: 'gate-router', plugin: 'gate-router', options: {} },
      escalationLevels: [
        { name: 'opus', plugin: 'claude-cli', options: { model: 'opus' } },
        { name: 'fable', plugin: 'claude-cli', options: {} },
      ],
      executors: [{ name: 'test', plugin: 'test', options: {} }],
      jobSources: [],
      machines: [{ name: 'local', plugin: 'local', options: {} }],
      usageSources: [],
      notifiers: [{ name: 'grok-bot', plugin: 'grokbot-routine', options: { envFile: '/x/g.env' } }],
      warnings: [],
    });
  });

  it('notifiers: 0..n under unique names; `notifiers: []` reads as none, not as absent', () => {
    expect(loadPluginsConfig({ version: 1, notifiers: [] })).toEqual({ notifiers: [], warnings: [] });
    expect(loadPluginsConfig({ version: 1, notifiers: [{ name: 'n', plugin: 'a' }, { name: 'n', plugin: 'b' }] })).toEqual({ error: expect.stringMatching(/notifiers: n named twice/) });
  });

  it('jobSources and usageSources: 0..n instances in order, each with its options', () => {
    const r = loadPluginsConfig({
      version: 1,
      jobSources: [
        { name: 'github', plugin: 'github-gh', options: { enabled: 'auto' } },
        { name: 'github-app', plugin: 'github-app' },
      ],
      usageSources: [{ name: 'budget', plugin: 'my-usage' }],
    });
    expect(r).toEqual({
      jobSources: [
        { name: 'github', plugin: 'github-gh', options: { enabled: 'auto' } },
        { name: 'github-app', plugin: 'github-app', options: {} },
      ],
      usageSources: [{ name: 'budget', plugin: 'my-usage', options: {} }],
      warnings: [],
    });
  });

  it('executors: 1..n instances in order, each with its options', () => {
    const r = loadPluginsConfig({
      version: 1,
      executors: [
        { name: 'herdr-claude', plugin: 'herdr-claude', options: { cwd: '~/w', args: ['--x'] } },
        { name: 'test', plugin: 'test' },
      ],
    });
    expect(r).toEqual({
      executors: [
        { name: 'herdr-claude', plugin: 'herdr-claude', options: { cwd: '~/w', args: ['--x'] } },
        { name: 'test', plugin: 'test', options: {} },
      ],
      warnings: [],
    });
  });

  it('escalationLevels: [] means no levels (questions go straight to the human); absent means the built-in ones', () => {
    expect(loadPluginsConfig({ version: 1, escalationLevels: [] })).toEqual({ escalationLevels: [], warnings: [] });
    expect(loadPluginsConfig({ version: 1 })).toEqual({ warnings: [] });
  });

  it.each([
    ['not an object', 'version: 1', /^the plugins config: \(config\)/],
    ['wrong version', { version: 2 }, /^the plugins config: version/],
    ['unknown top-level key', { version: 1, routers: {} }, /routers/],
    ['router without a plugin', { version: 1, router: { name: 'gate-router' } }, /router\.plugin/],
    ['router with an empty name', { version: 1, router: { name: '', plugin: 'x' } }, /router\.name/],
    ['options not a map', { version: 1, router: { name: 'a', plugin: 'b', options: 3 } }, /router\.options/],
    ['escalationLevels: null', { version: 1, escalationLevels: null }, /escalationLevels/],
    ['a level named human (the human stage)', { version: 1, escalationLevels: [{ name: 'human', plugin: 'claude-cli' }] }, /human is the human stage/],
    ['a level named after a model (issue #209)', { version: 1, escalationLevels: [{ name: 'fable', plugin: 'claude-cli', options: { model: 'sonnet' } }] }, /escalationLevels: fable is a model name; name the level as a level/],
    ['a level named after a full model id', { version: 1, escalationLevels: [{ name: 'claude-sonnet-4-5', plugin: 'anthropic-api' }] }, /claude-sonnet-4-5 is a model name/],
    ['a level named after its own model option', { version: 1, escalationLevels: [{ name: 'mine', plugin: 'anthropic-api', options: { model: 'mine' } }] }, /mine is a model name/],
    ['two levels with one name (a question stage names its level)', { version: 1, escalationLevels: [{ name: 'x', plugin: 'claude-cli' }, { name: 'x', plugin: 'claude-cli' }] }, /escalationLevels: x named twice/],
    ['the old answerer section', { version: 1, answerer: { name: 'opus', plugin: 'claude-cli' } }, /answerer/],
    ['executors: [] (at least one executor)', { version: 1, executors: [] }, /executors/],
    ['executors: null', { version: 1, executors: null }, /executors/],
    ['two executors with one name (jobs name their executor)', { version: 1, executors: [{ name: 't', plugin: 'test' }, { name: 't', plugin: 'herdr-claude' }] }, /executors.*t.*twice|twice/],
    ['executor without a plugin', { version: 1, executors: [{ name: 't' }] }, /executors\.0\.plugin/],
    ['two job sources with one name (sync state is keyed by it)', { version: 1, jobSources: [{ name: 'g', plugin: 'github-gh' }, { name: 'g', plugin: 'github-app' }] }, /jobSources.*g.*twice/],
    ['two usage sources with one name', { version: 1, usageSources: [{ name: 'u', plugin: 'a' }, { name: 'u', plugin: 'b' }] }, /usageSources.*u.*twice/],
    ['machines: null', { version: 1, machines: null }, /machines/],
    ['machines as a map (issue #74: a list, this machine and the attached ones)', { version: 1, machines: { name: 'local', plugin: 'local' } }, /machines/],
    ['two machines with one name (lanes and jobs are stored under it)', { version: 1, machines: [{ name: 'm', plugin: 'local' }, { name: 'm', plugin: 'ssh', options: { ssh: 'x', lanes: 1 } }] }, /machines: m named twice/],
    ['attachedMachines (issue #74: machine-source instances in machines:)', { version: 1, attachedMachines: [] }, /attachedMachines/],
  ])('%s is an error naming the problem', (_name, value, why) => {
    const r = loadPluginsConfig(value);
    expect(r).toEqual({ error: expect.stringMatching(why) });
  });
});
