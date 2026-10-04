// The GitHub job sources' plugin options (what sources.yaml's `github:` / `githubApp:` blocks
// became in plugins.yaml `jobSources[].options`), validated by the plugin host with each plugin's
// schema, and the source config they turn into.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import githubApp from '../../src/plugins/job-source/github-app/index.ts';
import githubGh from '../../src/plugins/job-source/github-gh/index.ts';
import { parseOptions } from '../../src/plugins/options.ts';
import { sourceConfig } from '../../src/sources/config.ts';

const SHARED_DEFAULTS = {
  pollSeconds: 60,
  repos: [],
  authors: ['owner'],
  label: 'hopper',
  priorityLabels: { 'hopper:p0': 100, 'hopper:p1': 75, 'hopper:p2': 50, 'hopper:p3': 25 },
  defaultPriority: 50,
  repoPaths: {},
  defaultCwd: '~/workbench/app-workflows',
  executor: 'herdr-claude',
  model: null,
  progressCommentSeconds: 300,
  recentComments: 10,
  projects: {},
};

const ok = (r: ReturnType<typeof parseOptions>) => {
  if (!r.ok) throw new Error(r.error);
  return r.options;
};

describe('github-gh options', () => {
  it('{} gets every default from the design, plus the gh bin and the app file it pauses for', () => {
    expect(ok(parseOptions(githubGh, {}))).toEqual({
      enabled: 'auto', owners: [], bin: 'gh', appFile: '~/.config/job-hopper/github-app.json', ...SHARED_DEFAULTS,
    });
  });

  it('the source config expands ~ in defaultCwd and repoPaths and keeps a configured model', () => {
    const o = ok(parseOptions(githubGh, {
      defaultCwd: '~/work', repoPaths: { 'owner/sandbox': '~/code/sandbox', 'o/abs': '/srv/abs' }, model: 'claude-sonnet-5', enabled: false,
    }));
    const c = sourceConfig(o as never);
    expect(c).toMatchObject({
      defaultCwd: join(homedir(), 'work'), repoPaths: { 'owner/sandbox': join(homedir(), 'code/sandbox'), 'o/abs': '/srv/abs' },
      model: 'claude-sonnet-5', enabled: false,
    });
    expect(sourceConfig(ok(parseOptions(githubGh, {})) as never)).not.toHaveProperty('model');
  });

  it('parses project priority config in both modes', () => {
    const o = ok(parseOptions(githubGh, { projects: {
      'owner/a': { owner: 'owner', number: 3, mode: 'field', field: 'Priority', map: { P0: 100, P1: 75 } },
      'owner/b': { owner: 'owner', number: 4, mode: 'rank' },
    } }));
    expect(o.projects).toEqual({
      'owner/a': { owner: 'owner', number: 3, mode: 'field', field: 'Priority', map: { P0: 100, P1: 75 } },
      'owner/b': { owner: 'owner', number: 4, mode: 'rank' },
    });
  });

  it.each([['auto', 'auto'], [true, true], [false, false]] as const)('enabled: %s is accepted', (v, want) => {
    expect(ok(parseOptions(githubGh, { enabled: v })).enabled).toBe(want);
  });

  it('appFile: null — never pauses for an app', () => {
    expect(ok(parseOptions(githubGh, { appFile: null })).appFile).toBeNull();
  });

  it.each([
    ['field mode without a field name', { projects: { 'o/r': { owner: 'o', number: 1, mode: 'field' } } }, /field/],
    ['an unknown key (typo)', { lable: 'hopper' }, /lable|Unrecognized/],
    ['a wrong type', { pollSeconds: 'soon' }, /pollSeconds/],
    ['enabled: maybe', { enabled: 'maybe' }, /enabled/],
  ])('%s is an error naming the path', (_n, raw, why) => {
    const r = parseOptions(githubGh, raw);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(why);
  });
});

describe('github-app options', () => {
  it('{} gets the defaults: enabled, the installed app file, no API override', () => {
    expect(ok(parseOptions(githubApp, {}))).toEqual({ enabled: true, appFile: '~/.config/job-hopper/github-app.json', ...SHARED_DEFAULTS });
  });

  it('apiUrl: an http(s) URL without its trailing slash (tests point it at a fake GitHub)', () => {
    expect(ok(parseOptions(githubApp, { apiUrl: 'http://127.0.0.1:9999/' })).apiUrl).toBe('http://127.0.0.1:9999');
    expect(parseOptions(githubApp, { apiUrl: 'not a url' }).ok).toBe(false);
  });

  it.each([
    ['owners (the installations are the allowlist)', { owners: ['x'] }],
    ['an unknown key', { lable: 'hopper' }],
    ['enabled: auto (only github-gh has auto)', { enabled: 'auto' }],
  ])('%s is an error', (_n, raw) => {
    expect(parseOptions(githubApp, raw).ok).toBe(false);
  });
});
