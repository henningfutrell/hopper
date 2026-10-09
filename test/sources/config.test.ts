// The GitHub job sources' plugin options (the plugins config `jobSources[].options`), validated by the
// plugin host with each plugin's schema, and the source config they turn into.
import { describe, expect, it } from 'vitest';
import githubApp from '../../src/plugins/job-source/github-app/index.ts';
import { optionsJsonSchema, parseOptions } from '../../src/plugins/options.ts';
import { sourceConfig } from '../../src/sources/config.ts';

/** No option is required: an empty instance is valid. */
const AUTHORS = {};

const SHARED_DEFAULTS = {
  pollSeconds: 60,
  repos: [],
  label: 'hopper',
  hopperName: null,
  priorityLabels: { 'hopper:high': 75, 'hopper:low': 25 },
  defaultPriority: 50,
  executor: 'herdr-claude',
  model: null,
  recentComments: 10,
  projects: {},
};

const ok = (r: ReturnType<typeof parseOptions>) => {
  if (!r.ok) throw new Error(r.error);
  return r.options;
};

describe('the GitHub sources\' shared options', () => {
  it('keeps a configured model', () => {
    const c = sourceConfig(ok(parseOptions(githubApp, { ...AUTHORS, model: 'claude-sonnet-5', enabled: false })) as never);
    expect(c).toMatchObject({ model: 'claude-sonnet-5', enabled: false });
    expect(sourceConfig(ok(parseOptions(githubApp, AUTHORS)) as never)).not.toHaveProperty('model');
  });

  // Issue #361: a path is one machine's; a source runs jobs on every machine, so it names none.
  it.each(['repoPaths', 'defaultCwd'])('refuses %s: the work tree is the machine\'s', (key) => {
    const r = parseOptions(githubApp, { ...AUTHORS, [key]: key === 'repoPaths' ? { 'o/r': '/srv/r' } : '/srv' });
    expect(r.ok).toBe(false);
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

  it.each([
    ['field mode without a field name', { projects: { 'o/r': { owner: 'o', number: 1, mode: 'field' } } }, /field/],
    ['an unknown key (typo)', { lable: 'hopper' }, /lable|Unrecognized/],
    ['a wrong type', { pollSeconds: 'soon' }, /pollSeconds/],
    ['enabled: maybe', { enabled: 'maybe' }, /enabled/],
  ])('%s is an error naming the path', (_n, raw, why) => {
    const r = parseOptions(githubApp, { ...AUTHORS, ...raw });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(why);
  });
});

describe('github-app options', () => {
  it('no options get the defaults: enabled, the default key variable, no identity yet, no API override', () => {
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

describe('authors: gone (issue #387) — intake is by label and assignee', () => {
  it('an instance still carrying authors loads; the option is dropped', () => {
    const o = ok(parseOptions(githubApp, { authors: ['someone'], label: 'work' }));
    expect(o).not.toHaveProperty('authors');
    expect(o.label).toBe('work');
  });

  it('authors is no option the Plugins form offers', () => {
    const schema = optionsJsonSchema(githubApp) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).not.toContain('authors');
  });
});

describe('completion: gone (issue #579) — done is always a pull request ready for review', () => {
  it.each(['merge', 'pull-request'])('an instance still carrying completion: %s loads; the option is dropped', (v) => {
    const o = ok(parseOptions(githubApp, { completion: v, label: 'work' }));
    expect(o).not.toHaveProperty('completion');
    expect(o.label).toBe('work');
  });

  it('completion is no option the Plugins form offers', () => {
    const schema = optionsJsonSchema(githubApp) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).not.toContain('completion');
  });
});
