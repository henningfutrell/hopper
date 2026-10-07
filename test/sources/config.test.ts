// The GitHub job sources' plugin options (the plugins config `jobSources[].options`), validated by the
// plugin host with each plugin's schema, and the source config they turn into.
import { describe, expect, it } from 'vitest';
import githubApp from '../../src/plugins/job-source/github-app/index.ts';
import { parseOptions } from '../../src/plugins/options.ts';
import { sourceConfig } from '../../src/sources/config.ts';

/** authors has no default: every valid instance names one. */
const AUTHORS = { authors: ['owner'] };

const SHARED_DEFAULTS = {
  pollSeconds: 60,
  repos: [],
  ...AUTHORS,
  label: 'hopper',
  hopperName: null,
  priorityLabels: { 'hopper:high': 75, 'hopper:low': 25 },
  defaultPriority: 50,
  repoPaths: {},
  defaultCwd: '~/hopper-jobs',
  executor: 'herdr-claude',
  model: null,
  recentComments: 10,
  projects: {},
  completion: 'merge',
};

const ok = (r: ReturnType<typeof parseOptions>) => {
  if (!r.ok) throw new Error(r.error);
  return r.options;
};

describe('the GitHub sources\' shared options', () => {
  it('the source config keeps ~ in defaultCwd and repoPaths for the job\'s machine to resolve (issue #323) and keeps a configured model', () => {
    const o = ok(parseOptions(githubApp, {
      ...AUTHORS, defaultCwd: '~/work', repoPaths: { 'owner/sandbox': '~/code/sandbox', 'o/abs': '/srv/abs' }, model: 'claude-sonnet-5', enabled: false,
    }));
    const c = sourceConfig(o as never);
    expect(c).toMatchObject({
      defaultCwd: '~/work', repoPaths: { 'owner/sandbox': '~/code/sandbox', 'o/abs': '/srv/abs' },
      model: 'claude-sonnet-5', enabled: false,
    });
    expect(sourceConfig(ok(parseOptions(githubApp, AUTHORS)) as never)).not.toHaveProperty('model');
  });

  it('parses project priority config in both modes', () => {
    const o = ok(parseOptions(githubApp, { ...AUTHORS, projects: {
      'owner/a': { owner: 'owner', number: 3, mode: 'field', field: 'Priority', map: { P0: 100, P1: 75 } },
      'owner/b': { owner: 'owner', number: 4, mode: 'rank' },
    } }));
    expect(o.projects).toEqual({
      'owner/a': { owner: 'owner', number: 3, mode: 'field', field: 'Priority', map: { P0: 100, P1: 75 } },
      'owner/b': { owner: 'owner', number: 4, mode: 'rank' },
    });
  });

  it.each(['merge', 'pull-request'] as const)('completion: %s is accepted (issue #187)', (v) => {
    expect(ok(parseOptions(githubApp, { ...AUTHORS, completion: v })).completion).toBe(v);
  });

  it.each([
    ['field mode without a field name', { projects: { 'o/r': { owner: 'o', number: 1, mode: 'field' } } }, /field/],
    ['an unknown key (typo)', { lable: 'hopper' }, /lable|Unrecognized/],
    ['a wrong type', { pollSeconds: 'soon' }, /pollSeconds/],
    ['enabled: maybe', { enabled: 'maybe' }, /enabled/],
    ['completion: commit (a local commit is never complete)', { completion: 'commit' }, /completion/],
  ])('%s is an error naming the path', (_n, raw, why) => {
    const r = parseOptions(githubApp, { ...AUTHORS, ...raw });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(why);
  });
});

describe('github-app options', () => {
  it('authors alone gets the defaults: enabled, the default key variable, no identity yet, no API override', () => {
    expect(ok(parseOptions(githubApp, AUTHORS))).toEqual({ enabled: true, privateKeyEnv: 'GITHUB_APP_PRIVATE_KEY', ...SHARED_DEFAULTS });
  });

  it('apiUrl: an http(s) URL without its trailing slash (tests point it at a fake GitHub)', () => {
    expect(ok(parseOptions(githubApp, { ...AUTHORS, apiUrl: 'http://127.0.0.1:9999/' })).apiUrl).toBe('http://127.0.0.1:9999');
    expect(parseOptions(githubApp, { ...AUTHORS, apiUrl: 'not a url' }).ok).toBe(false);
  });

  it.each([
    ['owners (the installations are the allowlist)', { owners: ['x'] }],
    ['an unknown key', { lable: 'hopper' }],
    ['enabled: auto', { enabled: 'auto' }],
  ])('%s is an error', (_n, raw) => {
    expect(parseOptions(githubApp, { ...AUTHORS, ...raw }).ok).toBe(false);
  });
});

describe('authors: the allowlist is always explicit', () => {
  it('github-app without authors is an error naming authors', () => {
    const r = parseOptions(githubApp, {});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/authors/);
  });

  it('github-app with authors: [] is an error', () => {
    expect(parseOptions(githubApp, { authors: [] }).ok).toBe(false);
  });
});
