import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';

const DB = { JOB_HOPPER_DATABASE_URL: 'sqlite:/d/db.sqlite' };

describe('configuration from env: process settings only (phase 5 slice 4)', () => {
  it('JOB_HOPPER_DATABASE_URL is required: no database is assumed on this machine', () => {
    expect(() => loadConfig({})).toThrow(/JOB_HOPPER_DATABASE_URL: required: sqlite:<path> or postgres:/);
    expect(() => loadConfig({ JOB_HOPPER_DATABASE_URL: '/var/lib/db.sqlite' })).toThrow(/JOB_HOPPER_DATABASE_URL: must be sqlite:<path> or postgres:/);
  });

  it('JOB_HOPPER_DB is no longer read: it is a leftover variable', () => {
    expect(loadConfig({ JOB_HOPPER_DATABASE_URL: 'sqlite:/d/db.sqlite', JOB_HOPPER_DB: '/x.db' }).leftoverEnv).toEqual({ JOB_HOPPER_DB: '/x.db' });
  });

  it('uses the documented defaults when only the database is given', () => {
    const c = loadConfig({ JOB_HOPPER_DATABASE_URL: 'sqlite:/d/db.sqlite' });
    expect(c).toEqual({
      host: '127.0.0.1',
      port: 4790,
      databaseUrl: 'sqlite:/d/db.sqlite',
      workDir: join(tmpdir(), 'job-hopper'),
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
      uiSessionHours: 12,
      pluginDir: join(homedir(), '.config/job-hopper/plugins'),
      pluginsFile: join(homedir(), '.config/job-hopper/plugins.yaml'),
      lanNames: [],
      lanPeers: [],
      leftoverEnv: {},
    });
  });

  it('reads every process setting and expands ~', () => {
    const c = loadConfig({
      JOB_HOPPER_PORT: '0', JOB_HOPPER_DATABASE_URL: 'postgres://jh:pw@db:5432/jh', JOB_HOPPER_WORK_DIR: '/var/tmp/jh', JOB_HOPPER_TICK_MS: '50',
      JOB_HOPPER_ROUTER_MODE: 'active', JOB_HOPPER_SOFT_LIMIT: '0.5', JOB_HOPPER_HARD_LIMIT: '0.9', JOB_HOPPER_ROUTER_CHEAP_BOOST: '5',
      JOB_HOPPER_WEBHOOK_BASE_MS: '20', JOB_HOPPER_LANE_IDLE_GRACE_MS: '100', JOB_HOPPER_ANSWER_TIMEOUT_MS: '1000',
      JOB_HOPPER_RULES_FILE: '~/r.md', JOB_HOPPER_HUMAN_RENOTIFY_MS: '10', JOB_HOPPER_HUMAN_TIMEOUT_MS: '20',
      JOB_HOPPER_RESUME_BOOST: '7', JOB_HOPPER_MAX_QUESTIONS: '1', JOB_HOPPER_KEEP_PANES: 'true',
      JOB_HOPPER_WEBHOOKS_FILE: '/etc/w.yaml', JOB_HOPPER_UI_SESSION_HOURS: '1.5',
      JOB_HOPPER_PLUGIN_DIR: '~/p', JOB_HOPPER_PLUGINS_FILE: '/etc/p.yaml',
      JOB_HOPPER_LAN_NAMES: ' Server , 192.0.2.29', JOB_HOPPER_LAN_PEERS: '192.0.2.0/24, 100.64.0.0/10',
    });
    expect(c).toEqual({
      host: '::', port: 0, databaseUrl: 'postgres://jh:pw@db:5432/jh', workDir: '/var/tmp/jh', tickMs: 50, routerMode: 'active',
      softLimit: 0.5, hardLimit: 0.9, routerCheapBoost: 5, webhookBaseMs: 20, laneIdleGraceMs: 100, answerTimeoutMs: 1000,
      rulesFile: join(homedir(), 'r.md'), humanRenotifyMs: 10, humanTimeoutMs: 20, resumeBoost: 7, maxQuestions: 1, keepPanes: true,
      webhooksFile: '/etc/w.yaml', uiSessionHours: 1.5,
      pluginDir: join(homedir(), 'p'), pluginsFile: '/etc/p.yaml',
      lanNames: ['server', '192.0.2.29'], lanPeers: ['192.0.2.0/24', '100.64.0.0/10'], leftoverEnv: {},
    });
  });

  it('a part-choosing variable is no longer read: it lands in leftoverEnv with every other unread JOB_HOPPER_* variable, unvalidated', () => {
    const c = loadConfig({
      JOB_HOPPER_EXECUTORS: 'Not A Name', JOB_HOPPER_LOCAL_LANES: '-1', JOB_HOPPER_CLAUDE_CWD: '~/w', JOB_HOPPER_SOURCES_FILE: '~/s.yaml',
      JOB_HOPPER_JEV_MODE: 'active', JOB_HOPPER_JEV_ADVISOR: 'router', JOB_HOPPER_GITHUB_API: 'not a url', JOB_HOPPER_ANSWERER: 'fake',
      JOB_HOPPER_GROKBOT_WEBHOOK_FILE: '~/g.env', JOB_HOPPER_HOST: '0.0.0.0', JOB_HOPPER_PORT: '0', OTHER: 'x', JOB_HOPPER_EMPTY: '',
      JOB_HOPPER_DATABASE_URL: 'sqlite:/d/db.sqlite',
    });
    expect(c.leftoverEnv).toEqual({
      JOB_HOPPER_EXECUTORS: 'Not A Name', JOB_HOPPER_LOCAL_LANES: '-1', JOB_HOPPER_CLAUDE_CWD: '~/w', JOB_HOPPER_SOURCES_FILE: '~/s.yaml',
      JOB_HOPPER_JEV_MODE: 'active', JOB_HOPPER_JEV_ADVISOR: 'router', JOB_HOPPER_GITHUB_API: 'not a url', JOB_HOPPER_ANSWERER: 'fake',
      JOB_HOPPER_GROKBOT_WEBHOOK_FILE: '~/g.env', JOB_HOPPER_HOST: '0.0.0.0',
    });
    expect(c.routerMode).toBe('shadow');
    expect(c).not.toHaveProperty('executors');
    expect(c).not.toHaveProperty('localLanes');
    expect(c).not.toHaveProperty('sourcesFile');
    expect(c).not.toHaveProperty('grokbotWebhookFile');
  });

  it.each([
    ['JOB_HOPPER_PORT', 'abc'],
    ['JOB_HOPPER_PORT', '70000'],
    ['JOB_HOPPER_TICK_MS', '0'],
    ['JOB_HOPPER_ROUTER_MODE', 'loud'],
    ['JOB_HOPPER_SOFT_LIMIT', '1.5'],
    ['JOB_HOPPER_LAN_NAMES', 'arch box'],
    ['JOB_HOPPER_LAN_NAMES', 'server:4790'],
    ['JOB_HOPPER_LAN_NAMES', 'localhost'],
    ['JOB_HOPPER_LAN_PEERS', '192.0.2.0'],
    ['JOB_HOPPER_LAN_PEERS', '192.0.2.0/33'],
    ['JOB_HOPPER_LAN_PEERS', 'lan'],
    ['JOB_HOPPER_KEEP_PANES', '1'],
    ['JOB_HOPPER_MAX_QUESTIONS', '-1'],
    ['JOB_HOPPER_HUMAN_TIMEOUT_MS', '0'],
    ['JOB_HOPPER_ANSWER_TIMEOUT_MS', '0'],
    ['JOB_HOPPER_UI_SESSION_HOURS', '0'],
    ['JOB_HOPPER_UI_SESSION_HOURS', 'soon'],
  ])('fails loudly on %s=%s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(name);
  });

  it('LAN names and LAN peers come together: one without the other fails loudly', () => {
    expect(() => loadConfig({ ...DB, JOB_HOPPER_LAN_NAMES: 'server' })).toThrow('JOB_HOPPER_LAN_PEERS');
    expect(() => loadConfig({ ...DB, JOB_HOPPER_LAN_PEERS: '192.0.2.0/24' })).toThrow('JOB_HOPPER_LAN_NAMES');
  });

  it('refuses a soft limit at or above the hard limit', () => {
    expect(() => loadConfig({ ...DB, JOB_HOPPER_SOFT_LIMIT: '0.9', JOB_HOPPER_HARD_LIMIT: '0.8' })).toThrow('SOFT_LIMIT');
  });
});
