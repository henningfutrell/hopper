import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';

describe('configuration from env', () => {
  it('uses the documented defaults on an empty environment', () => {
    const c = loadConfig({});
    expect(c).toEqual({
      host: '127.0.0.1',
      port: 4790,
      dbPath: join(homedir(), '.local/share/job-hopper/job-hopper.db'),
      tickMs: 2000,
      routerMode: 'shadow',
      localLanes: 4,
      softLimit: 0.7,
      hardLimit: 0.95,
      routerCheapBoost: 10,
      webhookBaseMs: 1000,
      laneIdleGraceMs: 5000,
      executors: ['test', 'herdr-claude'],
      herdrBin: 'herdr',
      herdrSession: 'job-hopper',
      herdrPollMs: 1000,
      claudeBin: 'claude',
      claudeArgs: ['--dangerously-skip-permissions'],
      claudeCwd: join(homedir(), 'workbench/app-workflows'),
      trustWorkdir: true,
      idleQuestionMs: 20000,
      answerer: 'claude',
      answerModelA: 'opus',
      answerModelB: 'fable',
      answerTimeoutMs: 180000,
      rulesFile: join(homedir(), '.config/job-hopper/rules.md'),
      humanRenotifyMs: 900000,
      humanTimeoutMs: 86400000,
      resumeBoost: 20,
      maxQuestions: 5,
      keepPanes: false,
      sourcesFile: join(homedir(), '.config/job-hopper/sources.yaml'),
      webhooksFile: join(homedir(), '.config/job-hopper/webhooks.yaml'),
      grokbotWebhookFile: join(homedir(), '.config/job-hopper/grokbot-webhook.env'),
      ghBin: 'gh',
      uiSessionHours: 12,
      pluginDir: join(homedir(), '.config/job-hopper/plugins'),
      pluginsFile: join(homedir(), '.config/job-hopper/plugins.yaml'),
    });
  });

  it('reads the phase-5 variables: the plugin dir and plugins.yaml', () => {
    expect(loadConfig({ JOB_HOPPER_PLUGIN_DIR: '~/p', JOB_HOPPER_PLUGINS_FILE: '/etc/p.yaml' })).toMatchObject({
      pluginDir: join(homedir(), 'p'), pluginsFile: '/etc/p.yaml',
    });
  });

  it('reads every phase-3 variable', () => {
    const c = loadConfig({
      JOB_HOPPER_SOURCES_FILE: '~/s.yaml', JOB_HOPPER_WEBHOOKS_FILE: '/etc/w.yaml', JOB_HOPPER_GH_BIN: '/opt/gh',
      JOB_HOPPER_UI_SESSION_HOURS: '1.5',
    });
    expect(c).toMatchObject({ sourcesFile: join(homedir(), 's.yaml'), webhooksFile: '/etc/w.yaml', ghBin: '/opt/gh', uiSessionHours: 1.5 });
  });

  it('reads the phase-4 variable: the GitHub API base for the App adapter and hopper-comment', () => {
    expect(loadConfig({}).githubApiUrl).toBeUndefined();
    expect(loadConfig({ JOB_HOPPER_GITHUB_API: 'http://127.0.0.1:9999/' })).toMatchObject({ githubApiUrl: 'http://127.0.0.1:9999' });
    expect(() => loadConfig({ JOB_HOPPER_GITHUB_API: 'not a url' })).toThrow(/JOB_HOPPER_GITHUB_API/);
  });

  it('reads every phase-2 variable', () => {
    const c = loadConfig({
      JOB_HOPPER_EXECUTORS: 'herdr-claude', JOB_HOPPER_HERDR_BIN: '/opt/herdr', JOB_HOPPER_HERDR_SESSION: 'jh-x',
      JOB_HOPPER_HERDR_POLL_MS: '50', JOB_HOPPER_CLAUDE_BIN: '/opt/claude', JOB_HOPPER_CLAUDE_ARGS: '--a  --b x',
      JOB_HOPPER_CLAUDE_CWD: '~/w', JOB_HOPPER_TRUST_WORKDIR: 'false', JOB_HOPPER_IDLE_QUESTION_MS: '300',
      JOB_HOPPER_ANSWERER: 'fake', JOB_HOPPER_ANSWER_MODEL_A: 'sonnet', JOB_HOPPER_ANSWER_MODEL_B: 'opus',
      JOB_HOPPER_ANSWER_TIMEOUT_MS: '1000', JOB_HOPPER_RULES_FILE: '~/r.md', JOB_HOPPER_HUMAN_RENOTIFY_MS: '10',
      JOB_HOPPER_HUMAN_TIMEOUT_MS: '20', JOB_HOPPER_RESUME_BOOST: '7', JOB_HOPPER_MAX_QUESTIONS: '1',
      JOB_HOPPER_KEEP_PANES: 'true',
    });
    expect(c).toMatchObject({
      executors: ['herdr-claude'], herdrBin: '/opt/herdr', herdrSession: 'jh-x', herdrPollMs: 50,
      claudeBin: '/opt/claude', claudeArgs: ['--a', '--b', 'x'], claudeCwd: join(homedir(), 'w'),
      trustWorkdir: false, idleQuestionMs: 300, answerer: 'fake', answerModelA: 'sonnet', answerModelB: 'opus',
      answerTimeoutMs: 1000, rulesFile: join(homedir(), 'r.md'), humanRenotifyMs: 10, humanTimeoutMs: 20,
      resumeBoost: 7, maxQuestions: 1, keepPanes: true,
    });
  });

  it('reads every variable and expands ~', () => {
    const c = loadConfig({
      JOB_HOPPER_HOST: '127.0.0.1', JOB_HOPPER_PORT: '0', JOB_HOPPER_DB: '~/x/db.sqlite',
      JOB_HOPPER_TICK_MS: '50', JOB_HOPPER_JEV_MODE: 'active',
      JOB_HOPPER_LOCAL_LANES: '2',
      JOB_HOPPER_SOFT_LIMIT: '0.5', JOB_HOPPER_HARD_LIMIT: '0.9', JOB_HOPPER_JEV_CHEAP_BOOST: '5',
      JOB_HOPPER_WEBHOOK_BASE_MS: '20', JOB_HOPPER_LANE_IDLE_GRACE_MS: '100',
    });
    expect(c.dbPath).toBe(join(homedir(), 'x/db.sqlite'));
    expect(c).toMatchObject({
      port: 0, tickMs: 50, routerMode: 'active',
      localLanes: 2, softLimit: 0.5, hardLimit: 0.9, routerCheapBoost: 5, webhookBaseMs: 20, laneIdleGraceMs: 100,
    });
  });

  it.each([
    ['JOB_HOPPER_PORT', 'abc'],
    ['JOB_HOPPER_PORT', '70000'],
    ['JOB_HOPPER_TICK_MS', '0'],
    ['JOB_HOPPER_JEV_MODE', 'loud'],
    ['JOB_HOPPER_LOCAL_LANES', '-1'],
    ['JOB_HOPPER_SOFT_LIMIT', '1.5'],
    ['JOB_HOPPER_HOST', '0.0.0.0'],
    ['JOB_HOPPER_EXECUTORS', 'test,nope'],
    ['JOB_HOPPER_EXECUTORS', ','],
    ['JOB_HOPPER_HERDR_SESSION', 'default'],
    ['JOB_HOPPER_TRUST_WORKDIR', 'yes'],
    ['JOB_HOPPER_KEEP_PANES', '1'],
    ['JOB_HOPPER_ANSWERER', 'grok'],
    ['JOB_HOPPER_MAX_QUESTIONS', '-1'],
    ['JOB_HOPPER_HUMAN_TIMEOUT_MS', '0'],
    ['JOB_HOPPER_HERDR_POLL_MS', 'x'],
    ['JOB_HOPPER_UI_SESSION_HOURS', '0'],
    ['JOB_HOPPER_UI_SESSION_HOURS', 'soon'],
  ])('fails loudly on %s=%s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(name);
  });

  it('refuses a soft limit at or above the hard limit', () => {
    expect(() => loadConfig({ JOB_HOPPER_SOFT_LIMIT: '0.9', JOB_HOPPER_HARD_LIMIT: '0.8' })).toThrow('SOFT_LIMIT');
  });
});
