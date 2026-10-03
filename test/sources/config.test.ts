import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSourcesFile } from '../../src/sources/config.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function file(text: string): string {
  const d = mkdtempSync(join(tmpdir(), 'jh-sources-'));
  dirs.push(d);
  const p = join(d, 'sources.yaml');
  writeFileSync(p, text);
  return p;
}

describe('loadSourcesFile', () => {
  it('a missing file means no GitHub source, with a note saying where it looked', () => {
    const r = loadSourcesFile('/nonexistent/jh/sources.yaml');
    expect(r).toMatchObject({ github: undefined });
    expect('note' in r && r.note).toMatch(/\/nonexistent\/jh\/sources\.yaml/);
  });

  it('a minimal github block gets every default from the design', () => {
    const r = loadSourcesFile(file('version: 1\ngithub: {}\n'));
    if ('error' in r) throw new Error(r.error);
    expect(r.github).toEqual({
      enabled: true,
      pollSeconds: 60,
      owners: [],
      repos: [],
      authors: ['owner'],
      label: 'hopper',
      priorityLabels: { 'hopper:p0': 100, 'hopper:p1': 75, 'hopper:p2': 50, 'hopper:p3': 25 },
      defaultPriority: 50,
      repoPaths: {},
      defaultCwd: join(homedir(), 'workbench/workflow-personal-app-management'),
      executor: 'herdr-claude',
      progressCommentSeconds: 300,
      recentComments: 10,
      projects: {},
    });
    expect(r.github?.model).toBeUndefined();
  });

  it('expands ~ in defaultCwd and repoPaths, and keeps a configured model', () => {
    const r = loadSourcesFile(file([
      'version: 1',
      'github:',
      '  defaultCwd: ~/work',
      '  repoPaths: { "owner/sandbox": "~/code/sandbox", "o/abs": /srv/abs }',
      '  model: claude-sonnet-5',
      '  enabled: false',
    ].join('\n')));
    if ('error' in r) throw new Error(r.error);
    expect(r.github?.defaultCwd).toBe(join(homedir(), 'work'));
    expect(r.github?.repoPaths).toEqual({ 'owner/sandbox': join(homedir(), 'code/sandbox'), 'o/abs': '/srv/abs' });
    expect(r.github?.model).toBe('claude-sonnet-5');
    expect(r.github?.enabled).toBe(false);
  });

  it('parses project priority config in both modes', () => {
    const r = loadSourcesFile(file([
      'version: 1',
      'github:',
      '  projects:',
      '    owner/a: { owner: owner, number: 3, mode: field, field: Priority, map: { P0: 100, P1: 75 } }',
      '    owner/b: { owner: owner, number: 4, mode: rank }',
    ].join('\n')));
    if ('error' in r) throw new Error(r.error);
    expect(r.github?.projects).toEqual({
      'owner/a': { owner: 'owner', number: 3, mode: 'field', field: 'Priority', map: { P0: 100, P1: 75 } },
      'owner/b': { owner: 'owner', number: 4, mode: 'rank' },
    });
  });

  it('field mode without a field name is invalid', () => {
    const r = loadSourcesFile(file('version: 1\ngithub:\n  projects:\n    o/r: { owner: o, number: 1, mode: field }\n'));
    expect('error' in r && r.error).toMatch(/field/);
  });

  it('a file without a github block has no GitHub source', () => {
    const r = loadSourcesFile(file('version: 1\n'));
    expect(r).toEqual({ github: undefined });
  });

  it.each([
    ['broken yaml', 'version: 1\ngithub: [\n'],
    ['wrong version', 'version: 2\ngithub: {}\n'],
    ['unknown key (typo)', 'version: 1\ngithub: { lable: hopper }\n'],
    ['wrong type', 'version: 1\ngithub: { pollSeconds: soon }\n'],
    ['not a mapping', '- a\n- b\n'],
  ])('%s → { error } naming the file', (_name, text) => {
    const p = file(text);
    const r = loadSourcesFile(p);
    expect('error' in r).toBe(true);
    expect('error' in r && r.error).toContain(p);
  });

  it('an invalid value names the offending path', () => {
    const r = loadSourcesFile(file('version: 1\ngithub: { pollSeconds: soon }\n'));
    expect('error' in r && r.error).toMatch(/pollSeconds/);
  });
});
