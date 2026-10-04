// job-hopper migrate-local (design.md "Migrating a local install"): a SQLite file and a config
// directory into an empty database of the backend under test, every row with its seq, the config
// files as documents with their file-path options rewritten, the secrets they pointed at returned
// as environment lines. The source is never written.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { runCli } from '../../src/cli.ts';
import { MigrateRefusal, migrateLocal, secretsEnvFile } from '../../src/migrate/local.ts';
import { pemFromEnv } from '../../src/sources/github/app/config.ts';
import { openStore } from '../../src/store/index.ts';
import { testDatabaseUrl } from '../support/database.ts';
import { KEYS } from '../support/github-app.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), 'jh-migrate-')); dirs.push(d); return d; };
const clock = { now: () => new Date('2026-10-04T12:00:00.000Z') };
const quiet = () => {};
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** A local install as the hopper left it: a store with rows in every table, and its config dir. */
function localInstall() {
  const dir = temp();
  const sqlite = join(dir, 'data', 'job-hopper.db');
  const s = openStore({ url: `sqlite:${sqlite}`, clock });
  const job = s.jobs.create({ executor: 'herdr-claude', payload: { prompt: 'p' } }, 50, { source: 'github-app', kind: 'github-app', key: 'https://x/1' });
  s.jobs.update(job.id, { status: 'running' });
  s.lanes.open('local');
  s.decisions.save({ id: 'd1' } as never);
  for (let i = 0; i < 450; i++) s.events.append({ type: 'job.progressed', jobId: job.id, data: { i } });
  const sub = s.webhooks.upsertByName({ name: 'hook', url: 'http://127.0.0.1:9/h', events: ['*'], secret: 's', active: true });
  s.webhooks.createDelivery(sub.id, s.events.since(0, 1)[0]!);
  s.settings.setRouterMode('active');
  s.questions.create({ jobId: job.id, text: 'q?', recentOutput: '', detectedBy: 'marker', tier: 'human' });
  s.uiSessions.create('a'.repeat(64), '2099-01-01T00:00:00.000Z');
  s.close();
  const config = join(dir, 'config');
  mkdirSync(config);
  writeFileSync(join(config, 'github-app.pem'), KEYS.privateKey);
  writeFileSync(join(config, 'github-app.json'), JSON.stringify({ version: 1, appId: 77, slug: 'hopper-qm', botLogin: 'hopper-qm[bot]', htmlUrl: 'https://github.com/apps/hopper-qm', owner: 'o', privateKeyFile: join(config, 'github-app.pem') }));
  writeFileSync(join(config, 'grokbot-webhook.env'), 'GROKBOT_WEBHOOK_URL=https://routine.invalid/hook\nGROKBOT_WEBHOOK_KEY=k3y\n');
  writeFileSync(join(config, 'typesafe-api-key'), 'ts-key\n');
  writeFileSync(join(config, 'hook.secret'), 'h00k\n');
  writeFileSync(join(config, 'plugins.yaml'), `version: 1
router:
  name: jev
  plugin: jev-router
  options:
    jevSrc: /srv/jev # the Jev checkout
    typesafeKeyFile: ${join(config, 'typesafe-api-key')}
jobSources:
  - name: github
    plugin: github-gh
    options:
      enabled: auto # auto: on only while no GitHub App is configured
      authors: [ someone ]
      appFile: ${join(config, 'github-app.json')}
  - name: github-app
    plugin: github-app
    options:
      appFile: ${join(config, 'github-app.json')}
      authors: [ someone ]
notifiers:
  - name: grok-bot
    plugin: grokbot-routine
    options:
      envFile: ${join(config, 'grokbot-webhook.env')}
`);
  writeFileSync(join(config, 'webhooks.yaml'), `version: 1\nwebhooks:\n  - name: hook\n    url: http://127.0.0.1:9/h\n    events: ["*"]\n    secretFile: ${join(config, 'hook.secret')}\n`);
  writeFileSync(join(config, 'rules.md'), '- be brief\n');
  return { sqlite, config, job };
}

function rowsOf(url: string) {
  const s = openStore({ url, clock });
  try {
    return {
      jobs: s.jobs.list(), lanes: s.lanes.list(), decisions: s.decisions.list(), events: s.events.since(0),
      webhooks: s.webhooks.list(), deliveries: s.webhooks.listDeliveries(), routerMode: s.settings.getRouterMode(),
      questions: s.questions.list(), session: s.uiSessions.find('a'.repeat(64), '2026-10-04T00:00:00.000Z'),
    };
  } finally { s.close(); }
}

describe('migrate-local', () => {
  it('copies every row with its seq; the next one continues past them', () => {
    const local = localInstall();
    const before = sha(local.sqlite);
    const target = testDatabaseUrl(temp());
    const r = migrateLocal({ sqlite: local.sqlite, target, log: quiet });
    expect(r.rows).toMatchObject({ jobs: 1, lanes: 1, decisions: 1, events: 450, webhooks: 1, deliveries: 1, settings: 1, questions: 1, ui_sessions: 1 });
    expect(rowsOf(target)).toEqual(rowsOf(`sqlite:${local.sqlite}`));
    expect(sha(local.sqlite)).toBe(before);
    const s = openStore({ url: target, clock });
    expect(s.events.append({ type: 'job.queued', data: {} }).seq).toBeGreaterThan(450);
    expect(s.jobs.create({ executor: 'test', payload: {} }, 1)).toBeDefined();
    s.close();
  });

  it('writes the config files as documents, every file path replaced, and returns the secrets they held', () => {
    const local = localInstall();
    const target = testDatabaseUrl(temp());
    const r = migrateLocal({ sqlite: local.sqlite, configDir: local.config, target, log: quiet });
    expect(r.documents.sort()).toEqual(['plugins.yaml', 'rules.md', 'webhooks.yaml']);
    const s = openStore({ url: target, clock });
    const plugins = s.documents.read('plugins.yaml')!;
    const webhooks = s.documents.read('webhooks.yaml')!;
    expect(s.documents.read('rules.md')).toBe('- be brief\n');
    s.close();
    expect(plugins).not.toMatch(/appFile|envFile|typesafeKeyFile/);
    expect(plugins).toContain('# the Jev checkout');
    const p = parse(plugins);
    expect(p.jobSources[0].options).toEqual({ enabled: 'auto', authors: ['someone'] });
    expect(p.jobSources[1].options).toEqual({ authors: ['someone'], appId: 77, slug: 'hopper-qm' });
    expect(p.notifiers[0]).toEqual({ name: 'grok-bot', plugin: 'grokbot-routine' });
    expect(p.router.options).toEqual({ jevSrc: '/srv/jev' });
    expect(parse(webhooks).webhooks[0]).toEqual({ name: 'hook', url: 'http://127.0.0.1:9/h', events: ['*'], secretEnv: 'WEBHOOK_SECRET_HOOK' });
    expect(r.secrets).toMatchObject({ GROKBOT_WEBHOOK_URL: 'https://routine.invalid/hook', GROKBOT_WEBHOOK_KEY: 'k3y', TYPESAFE_API_KEY: 'ts-key', WEBHOOK_SECRET_HOOK: 'h00k' });
    expect(r.secrets.GITHUB_APP_PRIVATE_KEY).not.toContain('\n');
    expect(pemFromEnv(r.secrets.GITHUB_APP_PRIVATE_KEY!)).toBe(KEYS.privateKey);
  });

  it('refuses a target that is not empty, and writes nothing to it', () => {
    const local = localInstall();
    const target = testDatabaseUrl(temp());
    const s = openStore({ url: target, clock });
    s.documents.write('plugins.yaml', 'version: 1\n', 'missing');
    s.close();
    expect(() => migrateLocal({ sqlite: local.sqlite, target, log: quiet })).toThrow(MigrateRefusal);
    expect(() => migrateLocal({ sqlite: local.sqlite, target, log: quiet })).toThrow(/not empty \(config_documents\)/);
    expect(rowsOf(target).jobs).toEqual([]);
  });

  it('refuses a plugins.yaml that would not load, before anything is copied', () => {
    const local = localInstall();
    writeFileSync(join(local.config, 'plugins.yaml'), 'version: 2\n');
    const target = testDatabaseUrl(temp());
    expect(() => migrateLocal({ sqlite: local.sqlite, configDir: local.config, target, log: quiet })).toThrow(/plugins.yaml would not load/);
    expect(rowsOf(target).jobs).toEqual([]);
  });

  it('the CLI writes the secrets as an environment file, mode 600, and never over one', () => {
    const local = localInstall();
    const target = testDatabaseUrl(temp());
    const out = join(temp(), 'secrets.env');
    const io = (env: Record<string, string>) => ({ env, stdin: () => '', out: quiet, err: quiet });
    expect(runCli(['migrate-local', '--from-sqlite', local.sqlite, '--config-dir', local.config, '--secrets-out', out], io({ JOB_HOPPER_DATABASE_URL: target }))).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const text = readFileSync(out, 'utf8');
    expect(text).toContain('GROKBOT_WEBHOOK_KEY=k3y\n');
    expect(text).toMatch(/^GITHUB_APP_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\\n/m);
    expect(text).toBe(secretsEnvFile(migrateResultSecrets(text)));
    expect(runCli(['migrate-local', '--from-sqlite', local.sqlite, '--secrets-out', out], io({ JOB_HOPPER_DATABASE_URL: testDatabaseUrl(temp()) }))).toBe(1);
    expect(readFileSync(out, 'utf8')).toBe(text);
  });
});

/** The NAME=value lines of a secrets file, back as a record. */
function migrateResultSecrets(text: string): Record<string, string> {
  return Object.fromEntries(text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}
