import { describe, expect, it } from 'vitest';
import { loadPluginsFile } from '../../src/plugins/plugins-file.ts';

/** The document text as the store holds it. */
const file = (text: string): string => text;

describe('plugins.yaml (router, escalationLevels, executors, jobSources, machines, usageSources)', () => {
  it('absent document → missing, so the caller derives the router', () => {
    expect(loadPluginsFile(undefined)).toEqual({ missing: true });
  });

  it('reads the router instance', () => {
    const r = loadPluginsFile(file('version: 1\nrouter: { name: gate-router, plugin: gate-router, options: { python: python3 } }\n'));
    expect(r).toEqual({ router: { name: 'gate-router', plugin: 'gate-router', options: { python: 'python3' } }, warnings: [] });
  });

  it('options default to {}', () => {
    expect(loadPluginsFile(file('version: 1\nrouter: { name: open, plugin: pass-through }\n'))).toMatchObject({
      router: { name: 'open', plugin: 'pass-through', options: {} },
    });
  });

  it('a file without a router section reads as no router instance', () => {
    expect(loadPluginsFile(file('version: 1\n'))).toEqual({ warnings: [] });
  });

  it('reads every role section', () => {
    const r = loadPluginsFile(file([
      'version: 1',
      'router: { name: gate-router, plugin: gate-router }',
      'escalationLevels: [ { name: opus, plugin: claude-cli, options: { model: opus } }, { name: fable, plugin: claude-cli } ]',
      'executors: [ { name: test, plugin: test } ]',
      'jobSources: []',
      'machines: [ { name: local, plugin: local } ]',
      'usageSources: []',
      'notifiers: [ { name: grok-bot, plugin: grokbot-routine, options: { envFile: /x/g.env } } ]',
    ].join('\n')));
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
    expect(loadPluginsFile(file('version: 1\nnotifiers: []\n'))).toEqual({ notifiers: [], warnings: [] });
    expect(loadPluginsFile(file('version: 1\nnotifiers: [ { name: n, plugin: a }, { name: n, plugin: b } ]\n'))).toEqual({ error: expect.stringMatching(/notifiers: n named twice/) });
  });

  it('jobSources and usageSources: 0..n instances in order, each with its options', () => {
    const r = loadPluginsFile(file([
      'version: 1',
      'jobSources:',
      '  - { name: github, plugin: github-gh, options: { enabled: auto } }',
      '  - { name: github-app, plugin: github-app }',
      'usageSources: [ { name: budget, plugin: my-usage } ]',
    ].join('\n')));
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
    const r = loadPluginsFile(file([
      'version: 1',
      'executors:',
      '  - { name: herdr-claude, plugin: herdr-claude, options: { cwd: ~/w, args: [--x] } }',
      '  - { name: test, plugin: test }',
    ].join('\n')));
    expect(r).toEqual({
      executors: [
        { name: 'herdr-claude', plugin: 'herdr-claude', options: { cwd: '~/w', args: ['--x'] } },
        { name: 'test', plugin: 'test', options: {} },
      ],
      warnings: [],
    });
  });

  it('escalationLevels: [] means no levels (questions go straight to the human); absent means the built-in ones', () => {
    expect(loadPluginsFile(file('version: 1\nescalationLevels: []\n'))).toEqual({ escalationLevels: [], warnings: [] });
    expect(loadPluginsFile(file('version: 1\n'))).toEqual({ warnings: [] });
  });

  it.each([
    ['bad yaml', 'version: 1\nrouter: [unclosed\n', /plugins\.yaml/],
    ['wrong version', 'version: 2\n', /version/],
    ['unknown top-level key', 'version: 1\nrouters: {}\n', /routers/],
    ['router without a plugin', 'version: 1\nrouter: { name: gate-router }\n', /router\.plugin/],
    ['router with an empty name', 'version: 1\nrouter: { name: "", plugin: x }\n', /router\.name/],
    ['options not a map', 'version: 1\nrouter: { name: a, plugin: b, options: 3 }\n', /router\.options/],
    ['escalationLevels: null', 'version: 1\nescalationLevels: null\n', /escalationLevels/],
    ['a level named human (the human stage)', 'version: 1\nescalationLevels: [ { name: human, plugin: claude-cli } ]\n', /human is the human stage/],
    ['two levels with one name (a question stage names its level)', 'version: 1\nescalationLevels: [ { name: x, plugin: claude-cli }, { name: x, plugin: claude-cli } ]\n', /escalationLevels: x named twice/],
    ['the old answerer section', 'version: 1\nanswerer: { name: opus, plugin: claude-cli }\n', /answerer/],
    ['executors: [] (at least one executor)', 'version: 1\nexecutors: []\n', /executors/],
    ['executors: null', 'version: 1\nexecutors: null\n', /executors/],
    ['two executors with one name (jobs name their executor)', 'version: 1\nexecutors: [ { name: t, plugin: test }, { name: t, plugin: herdr-claude } ]\n', /executors.*t.*twice|twice/],
    ['executor without a plugin', 'version: 1\nexecutors: [ { name: t } ]\n', /executors\.0\.plugin/],
    ['two job sources with one name (sync state is keyed by it)', 'version: 1\njobSources: [ { name: g, plugin: github-gh }, { name: g, plugin: github-app } ]\n', /jobSources.*g.*twice/],
    ['two usage sources with one name', 'version: 1\nusageSources: [ { name: u, plugin: a }, { name: u, plugin: b } ]\n', /usageSources.*u.*twice/],
    ['machines: null', 'version: 1\nmachines: null\n', /machines/],
    ['machines as a map (issue #74: a list, this machine and the attached ones)', 'version: 1\nmachines: { name: local, plugin: local }\n', /machines/],
    ['two machines with one name (lanes and jobs are stored under it)', 'version: 1\nmachines: [ { name: m, plugin: local }, { name: m, plugin: ssh, options: { ssh: x, lanes: 1 } } ]\n', /machines: m named twice/],
    ['attachedMachines (issue #74: machine-source instances in machines:)', 'version: 1\nattachedMachines: []\n', /attachedMachines/],
  ])('%s is an error naming the problem', (_name, text, why) => {
    const r = loadPluginsFile(file(text));
    expect(r).toEqual({ error: expect.stringMatching(why) });
  });
});
