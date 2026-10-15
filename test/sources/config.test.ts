// The GitHub job source's plugin options (the plugins config `jobSources[].options`), validated by the
// plugin host with each plugin's schema, and the source config they turn into.
import { describe, expect, it } from 'vitest';
import githubAccount from '../../src/plugins/job-source/github-account/index.ts';
import { optionsJsonSchema, parseOptions } from '../../src/plugins/options.ts';
import { sourceConfig } from '../../src/sources/config.ts';

/** No option is required: an empty instance is valid. */
const AUTHORS = {};

const SHARED_DEFAULTS = {
  pollSeconds: 60,
  label: 'hopper',
  hopperName: null,
  priorityLabels: { 'hopper:high': 75, 'hopper:low': 25 },
  defaultPriority: 50,
  issueGraph: true,
  graphRefreshMinutes: 60,
  executor: 'herdr-claude',
  model: null,
  recentComments: 10,
  projects: {},
};

const ok = (r: ReturnType<typeof parseOptions>) => {
  if (!r.ok) throw new Error(r.error);
  return r.options;
};

describe('the GitHub source\'s options', () => {
  it('keeps a configured model', () => {
    const c = sourceConfig(ok(parseOptions(githubAccount, { ...AUTHORS, model: 'claude-sonnet-5', enabled: false })) as never);
    expect(c).toMatchObject({ model: 'claude-sonnet-5', enabled: false });
    expect(sourceConfig(ok(parseOptions(githubAccount, AUTHORS)) as never)).not.toHaveProperty('model');
  });

  // Issue #361: a path is one machine's; a source runs jobs on every machine, so it names none.
  it.each(['repoPaths', 'defaultCwd'])('refuses %s: the work tree is the machine\'s', (key) => {
    const r = parseOptions(githubAccount, { ...AUTHORS, [key]: key === 'repoPaths' ? { 'o/r': '/srv/r' } : '/srv' });
    expect(r.ok).toBe(false);
  });

  it('parses project priority config in both modes', () => {
    const o = ok(parseOptions(githubAccount, { ...AUTHORS, projects: {
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
    const r = parseOptions(githubAccount, { ...AUTHORS, ...raw });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(why);
  });
});

describe('github-account options', () => {
  it('no options get the defaults: enabled; privateKeyEnv as stored before issue #1243 is dropped', () => {
    expect(ok(parseOptions(githubAccount, AUTHORS))).toEqual({ enabled: true, ...SHARED_DEFAULTS });
    expect(ok(parseOptions(githubAccount, { ...AUTHORS, privateKeyEnv: 'MY_KEY' }))).toEqual({ enabled: true, ...SHARED_DEFAULTS });
  });

  it.each([
    ['an App id (issue #1377: no App identity of its own)', { appId: 1 }],
    ['an App slug', { slug: 'some-app' }],
    ['an API base', { apiUrl: 'http://127.0.0.1:9999' }],
    ['repos (the job repositories are chosen in Sources)', { repos: ['o/r'] }],
    ['an unknown key', { lable: 'hopper' }],
    ['enabled: auto', { enabled: 'auto' }],
  ])('%s is an error', (_n, raw) => {
    expect(parseOptions(githubAccount, { ...AUTHORS, ...raw }).ok).toBe(false);
  });
});

describe('authors: gone (issue #387) — intake is by label and assignee', () => {
  it('an instance still carrying authors loads; the option is dropped', () => {
    const o = ok(parseOptions(githubAccount, { authors: ['someone'], label: 'work' }));
    expect(o).not.toHaveProperty('authors');
    expect(o.label).toBe('work');
  });

  it('authors is no option the Plugins form offers', () => {
    const schema = optionsJsonSchema(githubAccount) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).not.toContain('authors');
  });
});

describe('completion: gone (issue #579) — done is always a pull request ready for review', () => {
  it.each(['merge', 'pull-request'])('an instance still carrying completion: %s loads; the option is dropped', (v) => {
    const o = ok(parseOptions(githubAccount, { completion: v, label: 'work' }));
    expect(o).not.toHaveProperty('completion');
    expect(o.label).toBe('work');
  });

  it('completion is no option the Plugins form offers', () => {
    const schema = optionsJsonSchema(githubAccount) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).not.toContain('completion');
  });
});
