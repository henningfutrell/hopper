import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';

describe('configuration from env: process settings only (phase 5 slice 4)', () => {
  it('uses the documented defaults on an empty environment', () => {
    const c = loadConfig({});
    expect(c).toEqual({
      host: '127.0.0.1',
      port: 4790,
      dbPath: join(homedir(), '.local/share/job-hopper/job-hopper.db'),
      tickMs: 2000,
      routerMode: 'shadow',
      softLimit: 0.7,
      hardLimit: 0.95,
      routerCheapBoost: 10,
      webhookBaseMs: 1000,
      laneIdleGraceMs: 5000,
      answerTimeoutMs: 180000,
      rulesFile: join(homedir(), '.config/job-hopper/rules.md'),
      humanRenotifyMs: 900000,
      humanTimeoutMs: 86400000,
      resumeBoost: 20,
      maxQuestions: 5,
      keepPanes: false,
      webhooksFile: join(homedir(), '.config/job-hopper/webhooks.yaml'),
      grokbotWebhookFile: join(homedir(), '.config/job-hopper/grokbot-webhook.env'),
      uiSessionHours: 12,
      pluginDir: join(homedir(), '.config/job-hopper/plugins'),
      pluginsFile: join(homedir(), '.config/job-hopper/plugins.yaml'),
      leftoverEnv: {},
    });
  });

  it('reads every process setting and expands ~', () => {
    const c = loadConfig({
      JOB_HOPPER_HOST: '127.0.0.1', JOB_HOPPER_PORT: '0', JOB_HOPPER_DB: '~/x/db.sqlite', JOB_HOPPER_TICK_MS: '50',
      JOB_HOPPER_ROUTER_MODE: 'active', JOB_HOPPER_SOFT_LIMIT: '0.5', JOB_HOPPER_HARD_LIMIT: '0.9', JOB_HOPPER_ROUTER_CHEAP_BOOST: '5',
      JOB_HOPPER_WEBHOOK_BASE_MS: '20', JOB_HOPPER_LANE_IDLE_GRACE_MS: '100', JOB_HOPPER_ANSWER_TIMEOUT_MS: '1000',
      JOB_HOPPER_RULES_FILE: '~/r.md', JOB_HOPPER_HUMAN_RENOTIFY_MS: '10', JOB_HOPPER_HUMAN_TIMEOUT_MS: '20',
      JOB_HOPPER_RESUME_BOOST: '7', JOB_HOPPER_MAX_QUESTIONS: '1', JOB_HOPPER_KEEP_PANES: 'true',
      JOB_HOPPER_WEBHOOKS_FILE: '/etc/w.yaml', JOB_HOPPER_GROKBOT_WEBHOOK_FILE: '~/g.env', JOB_HOPPER_UI_SESSION_HOURS: '1.5',
      JOB_HOPPER_PLUGIN_DIR: '~/p', JOB_HOPPER_PLUGINS_FILE: '/etc/p.yaml',
    });
    expect(c).toEqual({
      host: '127.0.0.1', port: 0, dbPath: join(homedir(), 'x/db.sqlite'), tickMs: 50, routerMode: 'active',
      softLimit: 0.5, hardLimit: 0.9, routerCheapBoost: 5, webhookBaseMs: 20, laneIdleGraceMs: 100, answerTimeoutMs: 1000,
      rulesFile: join(homedir(), 'r.md'), humanRenotifyMs: 10, humanTimeoutMs: 20, resumeBoost: 7, maxQuestions: 1, keepPanes: true,
      webhooksFile: '/etc/w.yaml', grokbotWebhookFile: join(homedir(), 'g.env'), uiSessionHours: 1.5,
      pluginDir: join(homedir(), 'p'), pluginsFile: '/etc/p.yaml', leftoverEnv: {},
    });
  });

  it('a part-choosing variable is no longer read: it lands in leftoverEnv with every other unread JOB_HOPPER_* variable, unvalidated', () => {
    const c = loadConfig({
      JOB_HOPPER_EXECUTORS: 'Not A Name', JOB_HOPPER_LOCAL_LANES: '-1', JOB_HOPPER_CLAUDE_CWD: '~/w', JOB_HOPPER_SOURCES_FILE: '~/s.yaml',
      JOB_HOPPER_JEV_MODE: 'active', JOB_HOPPER_JEV_ADVISOR: 'router', JOB_HOPPER_GITHUB_API: 'not a url', JOB_HOPPER_ANSWERER: 'fake',
      JOB_HOPPER_PORT: '0', OTHER: 'x', JOB_HOPPER_EMPTY: '',
    });
    expect(c.leftoverEnv).toEqual({
      JOB_HOPPER_EXECUTORS: 'Not A Name', JOB_HOPPER_LOCAL_LANES: '-1', JOB_HOPPER_CLAUDE_CWD: '~/w', JOB_HOPPER_SOURCES_FILE: '~/s.yaml',
      JOB_HOPPER_JEV_MODE: 'active', JOB_HOPPER_JEV_ADVISOR: 'router', JOB_HOPPER_GITHUB_API: 'not a url', JOB_HOPPER_ANSWERER: 'fake',
    });
    expect(c.routerMode).toBe('shadow');
    expect(c).not.toHaveProperty('executors');
    expect(c).not.toHaveProperty('localLanes');
    expect(c).not.toHaveProperty('sourcesFile');
  });

  it.each([
    ['JOB_HOPPER_PORT', 'abc'],
    ['JOB_HOPPER_PORT', '70000'],
    ['JOB_HOPPER_TICK_MS', '0'],
    ['JOB_HOPPER_ROUTER_MODE', 'loud'],
    ['JOB_HOPPER_SOFT_LIMIT', '1.5'],
    ['JOB_HOPPER_HOST', '0.0.0.0'],
    ['JOB_HOPPER_KEEP_PANES', '1'],
    ['JOB_HOPPER_MAX_QUESTIONS', '-1'],
    ['JOB_HOPPER_HUMAN_TIMEOUT_MS', '0'],
    ['JOB_HOPPER_ANSWER_TIMEOUT_MS', '0'],
    ['JOB_HOPPER_UI_SESSION_HOURS', '0'],
    ['JOB_HOPPER_UI_SESSION_HOURS', 'soon'],
  ])('fails loudly on %s=%s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(name);
  });

  it('refuses a soft limit at or above the hard limit', () => {
    expect(() => loadConfig({ JOB_HOPPER_SOFT_LIMIT: '0.9', JOB_HOPPER_HARD_LIMIT: '0.8' })).toThrow('SOFT_LIMIT');
  });
});
