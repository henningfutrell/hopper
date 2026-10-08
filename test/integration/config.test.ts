import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { SHIPPED_APPS } from '../../src/connected-accounts/hopper-app.ts';

const DB = { HOPPER_DATABASE_URL: 'postgres://u:p@db:5432/jh' };

describe('configuration from env: process settings only (phase 5 slice 4)', () => {
  it('HOPPER_DATABASE_URL is required: no database is assumed on this machine', () => {
    expect(() => loadConfig({})).toThrow(/HOPPER_DATABASE_URL: required: postgres:/);
    expect(() => loadConfig({ HOPPER_DATABASE_URL: '/var/lib/db.sqlite' })).toThrow(/HOPPER_DATABASE_URL: must be postgres:/);
    // Postgres is the only store: a SQLite file is refused like any other non-Postgres URL.
    expect(() => loadConfig({ HOPPER_DATABASE_URL: 'sqlite:/var/lib/db.sqlite' })).toThrow(/HOPPER_DATABASE_URL: must be postgres:/);
  });

  it('the database URL (it carries the password) may come from a mounted secret file: HOPPER_DATABASE_URL_FILE (issue #56)', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'jh-db-url-')), 'url');
    writeFileSync(file, 'postgres://u:from-file@db:5432/jh\n', { mode: 0o600 });
    const c = loadConfig({ HOPPER_DATABASE_URL_FILE: file });
    expect(c.databaseUrl).toBe('postgres://u:from-file@db:5432/jh');
    expect(c.leftoverEnv).toEqual({});
    expect(() => loadConfig({ ...DB, HOPPER_DATABASE_URL_FILE: file })).toThrow(/HOPPER_DATABASE_URL and HOPPER_DATABASE_URL_FILE are both set/);
  });

  it('HOPPER_SECRET_KEY is no longer read: the hopper seals nothing, it keeps no secret (issue #56)', () => {
    expect(loadConfig({ ...DB, HOPPER_SECRET_KEY: 'k' }).leftoverEnv).toEqual({ HOPPER_SECRET_KEY: 'k' });
  });

  it('HOPPER_DB is no longer read: it is a leftover variable', () => {
    expect(loadConfig({ ...DB, HOPPER_DB: '/x.db' }).leftoverEnv).toEqual({ HOPPER_DB: '/x.db' });
  });

  it('uses the documented defaults when only the database is given', () => {
    const c = loadConfig(DB);
    expect(c).toEqual({
      host: '127.0.0.1',
      port: 4790,
      databaseUrl: 'postgres://u:p@db:5432/jh',
      workDir: join(tmpdir(), 'hopper'),
      tickMs: 2000,
      softLimit: 0.7,
      hardLimit: 0.95,
      routerCheapBoost: 10,
      webhookBaseMs: 1000,
      laneIdleGraceMs: 5000,
      reconnectGraceMs: 120000,
      answerTimeoutMs: 180000,
      humanRenotifyMs: 900000,
      humanTimeoutMs: 86400000,
      resumeBoost: 20,
      maxQuestions: 5,
      keepPanes: false,
      localMachine: true,
      uiSessionHours: 12,
      publicUrl: undefined,
      lanNames: [],
      lanPeers: [],
      updateCheckMs: 60000,
      leftoverEnv: {},
      // The hopper's app (issue #214): its GitHub App on github.com.
      hopperApps: {
        github: {
          provider: 'github', url: 'https://github.com', apiUrl: 'https://api.github.com', clientId: SHIPPED_APPS.github.clientId,
          ...(SHIPPED_APPS.github.slug ? { slug: SHIPPED_APPS.github.slug } : {}),
        },
      },
    });
  });

  it('reads every process setting; paths are taken as given', () => {
    const c = loadConfig({
      HOPPER_PORT: '0', HOPPER_DATABASE_URL: 'postgres://jh:pw@db:5432/jh', HOPPER_WORK_DIR: '/var/tmp/jh', HOPPER_TICK_MS: '50',
      HOPPER_SOFT_LIMIT: '0.5', HOPPER_HARD_LIMIT: '0.9', HOPPER_ROUTER_CHEAP_BOOST: '5',
      HOPPER_WEBHOOK_BASE_MS: '20', HOPPER_LANE_IDLE_GRACE_MS: '100', HOPPER_RECONNECT_GRACE_MS: '3000', HOPPER_ANSWER_TIMEOUT_MS: '1000',
      HOPPER_HUMAN_RENOTIFY_MS: '10', HOPPER_HUMAN_TIMEOUT_MS: '20',
      HOPPER_RESUME_BOOST: '7', HOPPER_MAX_QUESTIONS: '1', HOPPER_KEEP_PANES: 'true', HOPPER_LOCAL_MACHINE: 'false',
      HOPPER_UI_SESSION_HOURS: '1.5', HOPPER_PLUGIN_DIR: '/srv/p', HOPPER_PUBLIC_URL: 'https://Hopper.Example.com/',
      HOPPER_LAN_NAMES: ' Server , 192.0.2.29', HOPPER_LAN_PEERS: '192.0.2.0/24, 100.64.0.0/10',
      HOPPER_UPDATE_CHECK_MS: '0', HOPPER_RESTART: 'respawn',
      HOPPER_GITHUB_URL: 'https://github.example.com/', HOPPER_GITHUB_CLIENT_ID: 'gh-id', HOPPER_GITHUB_APP_SLUG: 'hopper-x',
    });
    expect(c).toEqual({
      host: '::', port: 0, databaseUrl: 'postgres://jh:pw@db:5432/jh', workDir: '/var/tmp/jh', tickMs: 50,
      softLimit: 0.5, hardLimit: 0.9, routerCheapBoost: 5, webhookBaseMs: 20, laneIdleGraceMs: 100, reconnectGraceMs: 3000, answerTimeoutMs: 1000,
      humanRenotifyMs: 10, humanTimeoutMs: 20, resumeBoost: 7, maxQuestions: 1, keepPanes: true, localMachine: false,
      uiSessionHours: 1.5, pluginDir: '/srv/p', publicUrl: 'https://hopper.example.com',
      lanNames: ['server', '192.0.2.29'], lanPeers: ['192.0.2.0/24', '100.64.0.0/10'], updateCheckMs: 0, restart: 'respawn', leftoverEnv: {},
      hopperApps: {
        github: { provider: 'github', url: 'https://github.example.com', apiUrl: 'https://github.example.com/api/v3', clientId: 'gh-id', slug: 'hopper-x' },
      },
    });
  });

  it('the retired file settings are no longer read: they land in leftoverEnv', () => {
    const left = { HOPPER_RULES_FILE: '~/r.md', HOPPER_WEBHOOKS_FILE: '/etc/w.yaml', HOPPER_PLUGINS_FILE: '/etc/p.yaml', HOPPER_AUTH_FILE: '~/a.yaml' };
    const c = loadConfig({ ...DB, ...left });
    expect(c.leftoverEnv).toEqual(left);
    for (const k of ['rulesFile', 'webhooksFile', 'pluginsFile', 'authFile', 'pluginDir']) expect(c).not.toHaveProperty(k);
  });

  it('a public URL alone keeps the loopback bind (a reverse proxy on this host); with LAN peers it binds every interface', () => {
    expect(loadConfig({ ...DB, HOPPER_PUBLIC_URL: 'https://hopper.example.com' })).toMatchObject({ host: '127.0.0.1', publicUrl: 'https://hopper.example.com' });
    expect(loadConfig({ ...DB, HOPPER_PUBLIC_URL: 'https://hopper.example.com:8443', HOPPER_LAN_PEERS: '10.0.0.0/8' }))
      .toMatchObject({ host: '::', publicUrl: 'https://hopper.example.com:8443', lanNames: [] });
  });

  it.each([
    ['a path', 'https://example.com/hopper', /origin only/],
    ['loopback', 'http://localhost:4790', /loopback/],
    ['another scheme', 'ftp://example.com', /http/],
  ])('refuses a public URL with %s', (_what, url, msg) => {
    expect(() => loadConfig({ ...DB, HOPPER_PUBLIC_URL: url })).toThrow(msg);
  });

  it('a part-choosing variable is no longer read: it lands in leftoverEnv with every other unread HOPPER_* variable, unvalidated', () => {
    const c = loadConfig({
      HOPPER_EXECUTORS: 'Not A Name', HOPPER_LOCAL_LANES: '-1', HOPPER_CLAUDE_CWD: '~/w', HOPPER_SOURCES_FILE: '~/s.yaml',
      HOPPER_JEV_MODE: 'active', HOPPER_ROUTER_MODE: 'shadow', HOPPER_JEV_ADVISOR: 'router', HOPPER_GITHUB_API: 'not a url', HOPPER_ANSWERER: 'fake',
      HOPPER_GROKBOT_WEBHOOK_FILE: '~/g.env', HOPPER_HOST: '0.0.0.0', HOPPER_PORT: '0', OTHER: 'x', HOPPER_EMPTY: '',
      ...DB,
    });
    expect(c.leftoverEnv).toEqual({
      HOPPER_EXECUTORS: 'Not A Name', HOPPER_LOCAL_LANES: '-1', HOPPER_CLAUDE_CWD: '~/w', HOPPER_SOURCES_FILE: '~/s.yaml',
      HOPPER_JEV_MODE: 'active', HOPPER_ROUTER_MODE: 'shadow', HOPPER_JEV_ADVISOR: 'router', HOPPER_GITHUB_API: 'not a url', HOPPER_ANSWERER: 'fake',
      HOPPER_GROKBOT_WEBHOOK_FILE: '~/g.env', HOPPER_HOST: '0.0.0.0',
    });
    expect(c).not.toHaveProperty('routerMode');
    expect(c).not.toHaveProperty('executors');
    expect(c).not.toHaveProperty('localLanes');
    expect(c).not.toHaveProperty('sourcesFile');
    expect(c).not.toHaveProperty('grokbotWebhookFile');
  });

  it.each([
    ['HOPPER_PORT', 'abc'],
    ['HOPPER_PORT', '70000'],
    ['HOPPER_TICK_MS', '0'],
    ['HOPPER_RESTART', 'reboot'],
    ['HOPPER_UPDATE_CHECK_MS', '-1'],
    ['HOPPER_SOFT_LIMIT', '1.5'],
    ['HOPPER_LAN_NAMES', 'arch box'],
    ['HOPPER_LAN_NAMES', 'server:4790'],
    ['HOPPER_LAN_NAMES', 'localhost'],
    ['HOPPER_LAN_PEERS', '192.0.2.0'],
    ['HOPPER_LAN_PEERS', '192.0.2.0/33'],
    ['HOPPER_LAN_PEERS', 'lan'],
    ['HOPPER_KEEP_PANES', '1'],
    ['HOPPER_MAX_QUESTIONS', '-1'],
    ['HOPPER_HUMAN_TIMEOUT_MS', '0'],
    ['HOPPER_ANSWER_TIMEOUT_MS', '0'],
    ['HOPPER_UI_SESSION_HOURS', '0'],
    ['HOPPER_UI_SESSION_HOURS', 'soon'],
  ])('fails loudly on %s=%s', (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(name);
  });

  it('LAN names and LAN peers come together: one without the other fails loudly', () => {
    expect(() => loadConfig({ ...DB, HOPPER_LAN_NAMES: 'server' })).toThrow('HOPPER_LAN_PEERS');
    expect(() => loadConfig({ ...DB, HOPPER_LAN_PEERS: '192.0.2.0/24' })).toThrow('HOPPER_LAN_NAMES');
  });

  it('refuses a soft limit at or above the hard limit', () => {
    expect(() => loadConfig({ ...DB, HOPPER_SOFT_LIMIT: '0.9', HOPPER_HARD_LIMIT: '0.8' })).toThrow('SOFT_LIMIT');
  });
});
