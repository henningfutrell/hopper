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

describe('plugins.yaml (router section)', () => {
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

  it('allows the sections later slices read (nothing reads them yet)', () => {
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
    expect(r).toMatchObject({ router: { name: 'jev' } });
  });

  it.each([
    ['bad yaml', 'version: 1\nrouter: [unclosed\n', /plugins\.yaml/],
    ['wrong version', 'version: 2\n', /version/],
    ['unknown top-level key', 'version: 1\nrouters: {}\n', /routers/],
    ['router without a plugin', 'version: 1\nrouter: { name: jev }\n', /router\.plugin/],
    ['router with an empty name', 'version: 1\nrouter: { name: "", plugin: x }\n', /router\.name/],
    ['options not a map', 'version: 1\nrouter: { name: a, plugin: b, options: 3 }\n', /router\.options/],
  ])('%s is an error naming the problem', (_name, text, why) => {
    const r = loadPluginsFile(file(text));
    expect(r).toEqual({ error: expect.stringMatching(why) });
  });

  it('warns when the file is readable by group or other (options may hold secrets)', () => {
    const r = loadPluginsFile(file('version: 1\n', 0o644));
    expect(r).toEqual({ warnings: [expect.stringMatching(/chmod 600/)] });
  });
});
