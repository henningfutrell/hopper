// The daemon-side migration (design.md "Settled in slice 4"): on a boot with no plugins.yaml, build
// it from sources.yaml and the removed part-choosing env vars, write it mode 600 atomically, and
// rename sources.yaml to sources.yaml.migrated. An existing plugins.yaml is never touched. Temp
// dirs only.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ensurePluginsFile } from '../../src/plugins/migrate.ts';
import { useTempDirs } from './support.ts';

const temp = useTempDirs();
const quiet = { info() {}, warn() {} };

const SOURCES = `# job-hopper job sources (the owner's comment)
version: 1
github:
  enabled: auto               # auto: on only while no GitHub App is configured
  pollSeconds: 60
  repos: []
  authors: [owner]
  defaultCwd: ~/workbench/app-workflows
  priorityLabels: { "hopper:p0": 100, "hopper:p1": 75 }
githubApp:
  enabled: true
  appFile: ~/.config/job-hopper/github-app.json
  authors: [owner]
  pollSeconds: 30
`;

function setup(o: { sources?: string; plugins?: string } = {}) {
  const dir = temp();
  const pluginsFile = join(dir, 'plugins.yaml');
  const sourcesFile = join(dir, 'sources.yaml');
  if (o.sources !== undefined) writeFileSync(sourcesFile, o.sources, { mode: 0o600 });
  if (o.plugins !== undefined) writeFileSync(pluginsFile, o.plugins, { mode: 0o600 });
  return { dir, pluginsFile, sourcesFile };
}

const read = (path: string) => parse(readFileSync(path, 'utf8'));

const DEFAULT_HERDR = {
  name: 'herdr-claude', plugin: 'herdr-claude', options: {
    bin: 'herdr', claudeBin: 'claude', session: 'job-hopper', args: ['--dangerously-skip-permissions'],
    cwd: '~/workbench/app-workflows', trustWorkdir: true, pollMs: 1000, idleQuestionMs: 20000,
  },
};

describe('ensurePluginsFile', () => {
  it('sources.yaml + env: written 600 with every section; the job sources keep their names github and github-app; sources.yaml renamed .migrated', () => {
    const { dir, pluginsFile, sourcesFile } = setup({ sources: SOURCES });
    const r = ensurePluginsFile({
      pluginsFile, answerTimeoutMs: 1234, logger: quiet,
      env: {
        JOB_HOPPER_EXECUTORS: 'test,herdr-claude', JOB_HOPPER_LOCAL_LANES: '2', JOB_HOPPER_CLAUDE_CWD: '/home/user/w',
        JOB_HOPPER_HERDR_SESSION: 'jh', JOB_HOPPER_CLAUDE_ARGS: '--a  --b', JOB_HOPPER_TRUST_WORKDIR: 'false',
        JOB_HOPPER_CLAUDE_BIN: '/opt/claude', JOB_HOPPER_ANSWER_MODEL_A: 'sonnet', JOB_HOPPER_ANSWER_MODEL_B: 'haiku',
        JOB_HOPPER_GH_BIN: '/opt/gh', JOB_HOPPER_GITHUB_API: 'http://127.0.0.1:9/',
      },
    });
    expect(r).toEqual({ action: 'migrated', renamed: [`${sourcesFile}.migrated`] });
    expect(statSync(pluginsFile).mode & 0o777).toBe(0o600);
    expect(existsSync(sourcesFile)).toBe(false);
    expect(readFileSync(`${sourcesFile}.migrated`, 'utf8')).toBe(SOURCES);
    expect(read(pluginsFile)).toEqual({
      version: 1,
      queueSorter: { name: 'priority', plugin: 'priority' },
      answerer: { name: 'opus', plugin: 'claude-cli', options: { bin: '/opt/claude', model: 'sonnet', timeoutMs: 1234 } },
      assessor: { name: 'fable', plugin: 'claude-cli-assessor', options: { bin: '/opt/claude', model: 'haiku', timeoutMs: 1234 } },
      executors: [
        { name: 'test', plugin: 'test' },
        { ...DEFAULT_HERDR, options: { ...DEFAULT_HERDR.options, claudeBin: '/opt/claude', session: 'jh', args: ['--a', '--b'], cwd: '/home/user/w', trustWorkdir: false } },
      ],
      jobSources: [
        { name: 'github', plugin: 'github-gh', options: {
          enabled: 'auto', pollSeconds: 60, repos: [], authors: ['owner'], defaultCwd: '~/workbench/app-workflows',
          priorityLabels: { 'hopper:p0': 100, 'hopper:p1': 75 }, bin: '/opt/gh', appFile: '~/.config/job-hopper/github-app.json',
        } },
        { name: 'github-app', plugin: 'github-app', options: {
          enabled: true, appFile: '~/.config/job-hopper/github-app.json', authors: ['owner'], pollSeconds: 30, apiUrl: 'http://127.0.0.1:9',
        } },
      ],
      machines: { name: 'local', plugin: 'local', options: { lanes: 2 } },
      usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { bin: '/opt/claude', intervalSeconds: 600 } }],
      notifiers: [{ name: 'grok-bot', plugin: 'grokbot-routine', options: { envFile: join(dir, 'grokbot-webhook.env') } }],
    });
    expect(readdirSync(dir).sort()).toEqual(['plugins.yaml', 'sources.yaml.migrated']);
  });

  it("keeps sources.yaml's comments with the options they annotate", () => {
    const { pluginsFile } = setup({ sources: SOURCES });
    ensurePluginsFile({ pluginsFile, answerTimeoutMs: 180000, env: {}, logger: quiet });
    expect(readFileSync(pluginsFile, 'utf8')).toContain('# auto: on only while no GitHub App is configured');
  });

  it('drops progressCommentSeconds from both blocks (the hopper posts no progress comments since 2026-10-03), comments and other keys kept', () => {
    const { pluginsFile } = setup({ sources: [
      'version: 1',
      'github:',
      '  enabled: true',
      '  progressCommentSeconds: 300  # at most one progress-comment edit',
      '  recentComments: 10  # mine',
      'githubApp:',
      '  progressCommentSeconds: 300',
      '  label: hopper',
      '',
    ].join('\n') });
    ensurePluginsFile({ pluginsFile, answerTimeoutMs: 180000, env: {}, logger: quiet });
    const text = readFileSync(pluginsFile, 'utf8');
    expect(text).not.toContain('progressCommentSeconds');
    expect(text).toContain('# mine');
    const [gh, app] = read(pluginsFile).jobSources;
    expect(gh.options).toMatchObject({ enabled: true, recentComments: 10 });
    expect(app.options).toMatchObject({ label: 'hopper' });
  });

  it('nothing to migrate: the built-in defaults (github disabled, github-app waiting for the app file beside plugins.yaml)', () => {
    const { dir, pluginsFile } = setup();
    expect(ensurePluginsFile({ pluginsFile, answerTimeoutMs: 180000, env: {}, logger: quiet })).toEqual({ action: 'default', renamed: [] });
    expect(statSync(pluginsFile).mode & 0o777).toBe(0o600);
    expect(read(pluginsFile)).toEqual({
      version: 1,
      queueSorter: { name: 'priority', plugin: 'priority' },
      answerer: { name: 'opus', plugin: 'claude-cli', options: { bin: 'claude', model: 'opus', timeoutMs: 180000 } },
      assessor: { name: 'fable', plugin: 'claude-cli-assessor', options: { bin: 'claude', model: 'fable', timeoutMs: 180000 } },
      executors: [{ name: 'test', plugin: 'test' }, DEFAULT_HERDR],
      jobSources: [
        { name: 'github', plugin: 'github-gh', options: { enabled: false, bin: 'gh', appFile: join(dir, 'github-app.json') } },
        { name: 'github-app', plugin: 'github-app', options: { appFile: join(dir, 'github-app.json') } },
      ],
      machines: { name: 'local', plugin: 'local', options: { lanes: 4 } },
      usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { bin: 'claude', intervalSeconds: 600 } }],
      notifiers: [{ name: 'grok-bot', plugin: 'grokbot-routine', options: { envFile: join(dir, 'grokbot-webhook.env') } }],
    });
  });

  it('JOB_HOPPER_GROKBOT_WEBHOOK_FILE (removed in slice 5) becomes the grok-bot notifier\'s envFile; it alone counts as a migration', () => {
    const { pluginsFile } = setup();
    const r = ensurePluginsFile({ pluginsFile, answerTimeoutMs: 180000, env: { JOB_HOPPER_GROKBOT_WEBHOOK_FILE: '~/secrets/grok.env' }, logger: quiet });
    expect(r).toEqual({ action: 'migrated', renamed: [] });
    expect(read(pluginsFile).notifiers).toEqual([{ name: 'grok-bot', plugin: 'grokbot-routine', options: { envFile: '~/secrets/grok.env' } }]);
  });

  it('JOB_HOPPER_SOURCES_FILE elsewhere: the grok-bot env file is still beside plugins.yaml', () => {
    const { dir, pluginsFile } = setup();
    const other = setup({ sources: 'version: 1\n' });
    ensurePluginsFile({ pluginsFile, answerTimeoutMs: 180000, env: { JOB_HOPPER_SOURCES_FILE: other.sourcesFile }, logger: quiet });
    expect(read(pluginsFile).notifiers[0].options.envFile).toBe(join(dir, 'grokbot-webhook.env'));
  });

  it('the app source switched off: the gh source never pauses for an app file (as with githubApp.enabled: false)', () => {
    const { pluginsFile } = setup({ sources: 'version: 1\ngithub: { enabled: auto }\ngithubApp: { enabled: false }\n' });
    ensurePluginsFile({ pluginsFile, answerTimeoutMs: 180000, env: {}, logger: quiet });
    const [gh, app] = read(pluginsFile).jobSources;
    expect(gh.options).toMatchObject({ enabled: 'auto', appFile: null });
    expect(app.options).toMatchObject({ enabled: false });
  });

  it('JOB_HOPPER_SOURCES_FILE names where sources.yaml was', () => {
    const { pluginsFile } = setup();
    const other = setup({ sources: 'version: 1\ngithub: { enabled: true, label: elsewhere }\n' });
    const r = ensurePluginsFile({ pluginsFile, answerTimeoutMs: 180000, env: { JOB_HOPPER_SOURCES_FILE: other.sourcesFile }, logger: quiet });
    expect(r).toEqual({ action: 'migrated', renamed: [`${other.sourcesFile}.migrated`] });
    expect(read(pluginsFile).jobSources[0].options).toMatchObject({ label: 'elsewhere' });
    expect(read(pluginsFile).jobSources[1].options).toMatchObject({ appFile: join(other.dir, 'github-app.json') });
  });

  it('an existing plugins.yaml is never overwritten, and sources.yaml is left where it is', () => {
    const { pluginsFile, sourcesFile } = setup({ sources: SOURCES, plugins: 'version: 1\n# mine\n' });
    expect(ensurePluginsFile({ pluginsFile, answerTimeoutMs: 180000, env: { JOB_HOPPER_LOCAL_LANES: '9' }, logger: quiet })).toEqual({ action: 'kept' });
    expect(readFileSync(pluginsFile, 'utf8')).toBe('version: 1\n# mine\n');
    expect(readFileSync(sourcesFile, 'utf8')).toBe(SOURCES);
  });

  it('a second run does not migrate again', () => {
    const { pluginsFile } = setup({ sources: SOURCES });
    ensurePluginsFile({ pluginsFile, answerTimeoutMs: 180000, env: {}, logger: quiet });
    const once = readFileSync(pluginsFile, 'utf8');
    writeFileSync(join(pluginsFile, '..', 'sources.yaml'), 'version: 1\ngithub: { enabled: false }\n');
    expect(ensurePluginsFile({ pluginsFile, answerTimeoutMs: 180000, env: { JOB_HOPPER_LOCAL_LANES: '1' }, logger: quiet })).toEqual({ action: 'kept' });
    expect(readFileSync(pluginsFile, 'utf8')).toBe(once);
  });

  it.each([
    ['an unparseable sources.yaml', { sources: 'version: 1\ngithub: [\n' }, {}, /sources\.yaml/],
    ['an invalid removed env var', {}, { JOB_HOPPER_LOCAL_LANES: '-1' }, /JOB_HOPPER_LOCAL_LANES/],
    ['an executor list naming nothing', {}, { JOB_HOPPER_EXECUTORS: ',' }, /JOB_HOPPER_EXECUTORS/],
  ])('%s: refuses loudly, writes nothing, renames nothing', (_n, files, env, why) => {
    const { dir, pluginsFile } = setup(files);
    const before = readdirSync(dir).sort();
    expect(() => ensurePluginsFile({ pluginsFile, answerTimeoutMs: 180000, env, logger: quiet })).toThrow(why);
    expect(readdirSync(dir).sort()).toEqual(before);
  });
});
