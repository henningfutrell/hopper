import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPluginsFile } from '../../src/plugins/plugins-file.ts';
import { useTempDirs } from './support.ts';

const temp = useTempDirs();

function file(text: string, mode = 0o600): string {
  const path = join(temp(), 'plugins.yaml');
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

describe('plugins.yaml (router, answerer, assessor and executors sections)', () => {
  it('absent file → missing, so the caller derives the router', () => {
    expect(loadPluginsFile(join(temp(), 'none.yaml'))).toEqual({ missing: true });
  });

  it('reads the router instance', () => {
    const r = loadPluginsFile(file('version: 1\nrouter: { name: jev, plugin: jev-router, options: { python: python3 } }\n'));
    expect(r).toEqual({ router: { name: 'jev', plugin: 'jev-router', options: { python: 'python3' } }, warnings: [] });
  });

  it('options default to {}', () => {
    expect(loadPluginsFile(file('version: 1\nrouter: { name: open, plugin: pass-through }\n'))).toMatchObject({
      router: { name: 'open', plugin: 'pass-through', options: {} },
    });
  });

  it('a file without a router section reads as no router instance', () => {
    expect(loadPluginsFile(file('version: 1\n'))).toEqual({ warnings: [] });
  });

  it('reads the answerer, assessor and executor instances; the later sections are allowed, unread', () => {
    const r = loadPluginsFile(file([
      'version: 1',
      'router: { name: jev, plugin: jev-router }',
      'answerer: { name: opus, plugin: claude-cli, options: { model: opus } }',
      'assessor: { name: fable, plugin: claude-cli-assessor }',
      'executors: [ { name: test, plugin: test } ]',
      'jobSources: []',
      'machines: { name: local, plugin: local }',
      'usageSources: []',
      'notifiers: []',
    ].join('\n')));
    expect(r).toEqual({
      router: { name: 'jev', plugin: 'jev-router', options: {} },
      answerer: { name: 'opus', plugin: 'claude-cli', options: { model: 'opus' } },
      assessor: { name: 'fable', plugin: 'claude-cli-assessor', options: {} },
      executors: [{ name: 'test', plugin: 'test', options: {} }],
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

  it('answerer: null means no answerer (questions go straight to the human); absent means derive it', () => {
    expect(loadPluginsFile(file('version: 1\nanswerer: null\n'))).toEqual({ answerer: null, warnings: [] });
    expect(loadPluginsFile(file('version: 1\nassessor: { name: a, plugin: always-escalate }\n'))).toEqual({
      assessor: { name: 'a', plugin: 'always-escalate', options: {} }, warnings: [],
    });
  });

  it.each([
    ['bad yaml', 'version: 1\nrouter: [unclosed\n', /plugins\.yaml/],
    ['wrong version', 'version: 2\n', /version/],
    ['unknown top-level key', 'version: 1\nrouters: {}\n', /routers/],
    ['router without a plugin', 'version: 1\nrouter: { name: jev }\n', /router\.plugin/],
    ['router with an empty name', 'version: 1\nrouter: { name: "", plugin: x }\n', /router\.name/],
    ['options not a map', 'version: 1\nrouter: { name: a, plugin: b, options: 3 }\n', /router\.options/],
    ['assessor: null (the assessor slot is never empty)', 'version: 1\nassessor: null\n', /assessor/],
    ['answerer named human (the human stage)', 'version: 1\nanswerer: { name: human, plugin: claude-cli }\n', /answerer\.name.*human/],
    ['assessor named human', 'version: 1\nassessor: { name: human, plugin: always-escalate }\n', /assessor\.name.*human/],
    ['executors: [] (at least one executor)', 'version: 1\nexecutors: []\n', /executors/],
    ['executors: null', 'version: 1\nexecutors: null\n', /executors/],
    ['two executors with one name (jobs name their executor)', 'version: 1\nexecutors: [ { name: t, plugin: test }, { name: t, plugin: herdr-claude } ]\n', /executors.*t.*twice|twice/],
    ['executor without a plugin', 'version: 1\nexecutors: [ { name: t } ]\n', /executors\.0\.plugin/],
    ['answerer and assessor with one name', 'version: 1\nanswerer: { name: x, plugin: claude-cli }\nassessor: { name: x, plugin: always-escalate }\n', /same name/],
  ])('%s is an error naming the problem', (_name, text, why) => {
    const r = loadPluginsFile(file(text));
    expect(r).toEqual({ error: expect.stringMatching(why) });
  });

  it('warns when the file is readable by group or other (options may hold secrets)', () => {
    const r = loadPluginsFile(file('version: 1\n', 0o644));
    expect(r).toEqual({ warnings: [expect.stringMatching(/chmod 600/)] });
  });
});

describe('plugins.yaml attachedMachines (design.md "Attached machines")', () => {
  it('reads each attached machine with its defaults', () => {
    const r = loadPluginsFile(file([
      'version: 1',
      'attachedMachines:',
      '  - { name: laptop, ssh: laptop, lanes: 2 }',
      '  - { name: pi, ssh: user@host.example.net, label: Pi, lanes: 1, executors: [herdr-claude, other], session: jh, herdrBin: /opt/herdr }',
    ].join('\n')));
    expect(r).toEqual({
      attachedMachines: [
        { name: 'laptop', ssh: 'laptop', lanes: 2, executors: ['herdr-claude'], session: 'job-hopper', herdrBin: 'herdr' },
        { name: 'pi', ssh: 'user@host.example.net', label: 'Pi', lanes: 1, executors: ['herdr-claude', 'other'], session: 'jh', herdrBin: '/opt/herdr' },
      ],
      warnings: [],
    });
  });

  it.each([
    ['  - { name: local, ssh: laptop, lanes: 1 }', /local is this machine/],
    ['  - { name: a, ssh: laptop, lanes: 1 }\n  - { name: a, ssh: other, lanes: 1 }', /machine a named twice/],
    ['  - { name: a, ssh: -oProxyCommand=x, lanes: 1 }', /ssh/],
    ['  - { name: a, ssh: laptop, lanes: 0 }', /lanes/],
    ['  - { name: a, ssh: laptop, lanes: 1, session: default }', /default herdr session/],
    ['  - { name: a, lanes: 1 }', /ssh/],
  ])('refuses %s', (entry, why) => {
    const r = loadPluginsFile(file(`version: 1\nattachedMachines:\n${entry}\n`));
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toMatch(why);
  });
});
