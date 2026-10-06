// Several users of one hopper (issue #158, design.md "Users: one hopper, separate users"): the
// instance schema holds the users, their identity links, UI sessions, login codes, auth.yaml and the
// instance settings; each user's own tables live in a user schema of their own.
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/store/db.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { INSTANCE_SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { TENANT_SCHEMA_VERSION } from '../../src/store/tenant-migrations.ts';
import { installFromBefore, testPostgres } from '../support/database.ts';
import { fixedClock, spec, useTempStore } from './helpers.ts';

const t = useTempStore();

const schemaOf = (url: string): string => new URL(url).searchParams.get('schema')!;

/** Column name, type and default of every table of `schema`, by table, without the schema's own name. */
function shape(schema: string): Record<string, string[]> {
  const db = openDb(testPostgres());
  try {
    const out: Record<string, string[]> = {};
    for (const r of db.all(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = ? ORDER BY table_name, ordinal_position`, schema)) {
      const def = String(r.column_default ?? '').replaceAll(`${schema}.`, '').replaceAll(`"${schema}".`, '');
      (out[String(r.table_name)] ??= []).push(`${String(r.column_name)} ${String(r.data_type)} ${String(r.is_nullable)} ${def}`);
    }
    for (const r of db.all('SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = ? ORDER BY indexname', schema)) {
      (out[`index:${String(r.tablename)}`] ??= []).push(String(r.indexdef).replaceAll(`${schema}.`, '').replaceAll(`"${schema}".`, ''));
    }
    return out;
  } finally {
    db.close();
  }
}

describe('a fresh store', () => {
  it('holds no user: no bootstrap user, no user schema (issue #238)', () => {
    const url = t.url();
    const instance = openInstanceStore({ url, clock: fixedClock() });
    expect(instance.users.list()).toEqual([]);
    expect(instance.identities.userOf('none', 'anonymous')).toBeUndefined();
    instance.close();
    const raw = openDb(testPostgres());
    expect(raw.all('SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE ?', `${schemaOf(url)}_u_%`)).toEqual([]);
    expect(raw.get(`SELECT version FROM "${schemaOf(url)}".schema_version`)).toEqual({ version: INSTANCE_SCHEMA_VERSION });
    raw.close();
  });

  it('a user added to it gets a user schema of its own, on the latest tenant version', () => {
    const url = t.url();
    const instance = openInstanceStore({ url, clock: fixedClock() });
    const ada = instance.users.add('ada');
    const store = instance.userStore(ada);
    const job = store.jobs.create(spec, 50);
    store.close();
    instance.close();
    const raw = openDb(testPostgres());
    expect(raw.get(`SELECT id FROM "${schemaOf(url)}_u_ada".jobs`)).toEqual({ id: job.id });
    expect(raw.get(`SELECT version FROM "${schemaOf(url)}_u_ada".schema_version`)).toEqual({ version: TENANT_SCHEMA_VERSION });
    raw.close();
  });
});

describe('an install from before (issue #238: its default admin account stays)', () => {
  it('a user added later gets a slug id, a work dir, a secret prefix and a schema of the same shape as admin\'s', () => {
    const url = installFromBefore(t.url());
    const instance = openInstanceStore({ url, clock: fixedClock() });
    const ada = instance.users.add('Ada Lovelace');
    expect(ada).toEqual({ id: 'ada_lovelace', name: 'Ada Lovelace', createdAt: expect.any(String), workDir: 'users/ada_lovelace', secretPrefix: 'HOPPER_USER_ADA_LOVELACE_' });
    expect(instance.users.add('ada lovelace!').id).toBe('ada_lovelace_2');
    expect(() => instance.users.add('Ada Lovelace')).toThrow(/name Ada Lovelace is taken/);
    expect(instance.users.add('42').id).toBe('u42');
    expect(instance.users.list().map((u) => u.id)).toEqual(['admin', 'ada_lovelace', 'ada_lovelace_2', 'u42']);
    expect(instance.users.get('ada_lovelace')?.name).toBe('Ada Lovelace');
    expect(instance.users.get('nobody')).toBeUndefined();
    // Owner's schema is migrated on the tenant track when its store opens, as at every start.
    instance.userStore(instance.users.get('admin')!).close();
    instance.close();
    expect(shape(`${schemaOf(url)}_u_ada_lovelace`)).toEqual(shape(`${schemaOf(url)}_u_admin`));
  });

  it('one user never sees another\'s jobs, questions, events, config, settings or webhooks', () => {
    const instance = openInstanceStore({ url: installFromBefore(t.url()), clock: fixedClock() });
    const a = instance.userStore(instance.users.get('admin')!);
    const b = instance.userStore(instance.users.add('bea'));
    const job = a.jobs.create(spec, 50);
    a.questions.create({ jobId: job.id, text: 'q?', recentOutput: '', detectedBy: 'marker', tier: 'human' });
    a.events.append({ type: 'job.queued', jobId: job.id, data: {} });
    a.config.write('rules', 'a rules', 'missing');
    a.settings.setQueueGate({ mode: 'review', autoAcceptPerHour: null });
    a.webhooks.add({ name: 'w', url: 'http://127.0.0.1:1/', events: ['job.*'], secretEnv: 'S', active: true });
    expect(b.jobs.list()).toEqual([]);
    expect(b.jobs.get(job.id)).toBeUndefined();
    expect(b.questions.list()).toEqual([]);
    expect(b.events.since(0)).toEqual([]);
    expect(b.config.read('rules')).toBeUndefined();
    expect(b.settings.getQueueGate()).toBeUndefined();
    expect(b.webhooks.list()).toEqual([]);
    a.close();
    b.close();
    instance.close();
  });
});

describe('identity links, sessions and login codes belong to a user', () => {
  it('an identity is linked to one user', () => {
    const instance = openInstanceStore({ url: t.url(), clock: fixedClock() });
    const bea = instance.users.add('bea');
    expect(instance.identities.userOf('corp', 'sub-1')).toBeUndefined();
    instance.identities.link('corp', 'sub-1', bea.id);
    expect(instance.identities.userOf('corp', 'sub-1')).toBe(bea.id);
    instance.close();
  });

  it('a UI session carries its user', () => {
    const instance = openInstanceStore({ url: t.url(), clock: fixedClock() });
    const bea = instance.users.add('bea');
    const identity = { realm: 'local', subject: 'local', groups: [] };
    instance.uiSessions.create({ tokenHash: 'h', expiresAt: '2099-01-01T00:00:00.000Z', role: 'admin', identity, userId: bea.id });
    expect(instance.uiSessions.find('h', '2026-10-02T10:00:00.000Z')).toEqual({ tokenHash: 'h', expiresAt: '2099-01-01T00:00:00.000Z', role: 'admin', identity, userId: 'bea' });
    instance.close();
  });

  it('a login code is for one user: taking it names that user', () => {
    const instance = openInstanceStore({ url: t.url(), clock: fixedClock() });
    const bea = instance.users.add('bea');
    instance.loginCodes.create('c1', '2099-01-01T00:00:00.000Z', bea.id);
    expect(instance.loginCodes.live('c1', '2026-10-02T10:00:00.000Z')).toBe('bea');
    expect(instance.loginCodes.take('c1', '2026-10-02T10:00:00.000Z')).toBe('bea');
    expect(instance.loginCodes.take('c1', '2026-10-02T10:00:00.000Z')).toBeUndefined();
    instance.close();
  });
});

describe('migrations 17 and 21: an install from before becomes the default admin account, nothing lost', () => {
  it('moves every tenant table, document and setting to admin; seq continues; sessions and codes are admin\'s', () => {
    const url = t.url();
    const v16 = t.at(url, 16);
    const at = '2026-10-01T00:00:00.000Z';
    v16.run("INSERT INTO jobs (id, status, created_at, body, source_key) VALUES ('j1', 'queued', ?, ?, 'k1')", at,
      JSON.stringify({ id: 'j1', spec, priority: 50, status: 'queued', approved: false, createdAt: at, updatedAt: at, attempts: 0 }));
    v16.run("INSERT INTO questions (id, job_id, status, created_at, body) VALUES ('q1', 'j1', 'open', ?, ?)", at,
      JSON.stringify({ id: 'q1', jobId: 'j1', text: 'q?', recentOutput: '', detectedBy: 'marker', status: 'open', tier: 'human', attempts: [], createdAt: at, updatedAt: at }));
    v16.run("INSERT INTO events (id, type, at, job_id, data, schema_version) VALUES ('e1', 'job.queued', ?, 'j1', '{}', 1)", at);
    v16.run("INSERT INTO events (id, type, at, job_id, data, schema_version) VALUES ('e2', 'job.claimed', ?, 'j1', '{}', 1)", at);
    v16.run("INSERT INTO webhooks (id, url, events, active, created_at, name, secret_env) VALUES ('w1', 'http://127.0.0.1:1/', '[\"job.*\"]', 1, ?, 'hook', 'WEBHOOK_SECRET_A')", at);
    v16.run("INSERT INTO deliveries (id, subscription_id, status, body) VALUES ('d1', 'w1', 'delivered', ?)", JSON.stringify({ id: 'd1', subscriptionId: 'w1', status: 'delivered' }));
    v16.run("INSERT INTO lanes (id, machine_id, number, body) VALUES ('l1', 'local', 1, ?)", JSON.stringify({ id: 'l1', machineId: 'local', number: 1, state: 'idle' }));
    v16.run("INSERT INTO decisions (id, body) VALUES ('dec1', ?)", JSON.stringify({ id: 'dec1' }));
    v16.run("INSERT INTO config_documents (name, text, updated_at) VALUES ('plugins.yaml', 'version: 1\n', ?), ('rules.md', 'be kind', ?), ('auth.yaml', 'version: 1\n', ?)", at, at, at);
    v16.run("INSERT INTO settings (key, value) VALUES ('queueGate', '{\"mode\":\"review\",\"autoAcceptPerHour\":null}'), ('updateChannel', 'main'), ('autoUpdate', 'true'), ('pluginInstalls', '[]')");
    v16.run("INSERT INTO ui_sessions (token_hash, expires_at, role, identity) VALUES ('t1', '2099-01-01T00:00:00.000Z', 'operator', ?)",
      JSON.stringify({ provider: 'corp', subject: 'sub-9', name: 'Ada', groups: [] }));
    v16.run("INSERT INTO login_codes (code_hash, expires_at) VALUES ('c1', '2099-01-01T00:00:00.000Z')");
    v16.close();

    const instance = openInstanceStore({ url, clock: fixedClock() });
    expect(instance.users.list().map((u) => u.id)).toEqual(['admin']);
    const admin = instance.userStore(instance.users.get('admin')!);
    expect(admin.jobs.get('j1')?.status).toBe('queued');
    expect(admin.jobs.getBySourceKey('k1')?.id).toBe('j1');
    expect(admin.questions.get('q1')?.text).toBe('q?');
    expect(admin.events.since(0).map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(admin.webhooks.list().map((w) => w.name)).toEqual(['hook']);
    expect(admin.webhooks.listDeliveries().map((d) => d.id)).toEqual(['d1']);
    expect(admin.lanes.list().map((l) => l.id)).toEqual(['l1']);
    expect(admin.decisions.list().length).toBe(1);
    expect(admin.config.read('plugins')).toEqual({ version: 1 });
    expect(admin.config.read('rules')).toBe('be kind');
    expect(admin.settings.getQueueGate()).toEqual({ mode: 'review', autoAcceptPerHour: null });
    // The sequence moved with its table: the next event follows the last one.
    const next = admin.events.append({ type: 'job.started', jobId: 'j1', data: {} });
    expect(next.seq).toBeGreaterThan(admin.events.since(0)[1]!.seq);
    // Migration 22 (issue #214): every hopper offers GitHub sign-in.
    expect(instance.config.read('sign-in')).toEqual({ version: 1, realms: [{ name: 'github', label: 'GitHub', type: 'github' }] });
    expect(instance.settings.getUpdateSettings()).toEqual({ channel: 'main', autoUpdate: true });
    expect(instance.settings.getPluginInstalls()).toEqual([]);
    expect(instance.uiSessions.find('t1', '2026-10-02T10:00:00.000Z')?.userId).toBe('admin');
    expect(instance.loginCodes.take('c1', '2026-10-02T10:00:00.000Z')).toBe('admin');
    expect(instance.identities.userOf('corp', 'sub-9')).toBe('admin');
    admin.close();
    instance.close();
    const raw = openDb(testPostgres());
    const left = raw.all("SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name", schemaOf(url)).map((r) => r.table_name);
    expect(left).toEqual(['config', 'login_codes', 'schema_version', 'settings', 'ui_sessions', 'user_identities', 'users']);
    expect(raw.all(`SELECT name FROM "${schemaOf(url)}".config`)).toEqual([{ name: 'sign-in' }]);
    expect(raw.all(`SELECT key FROM "${schemaOf(url)}".settings ORDER BY key`).map((r) => r.key)).toEqual(['autoUpdate', 'pluginInstalls', 'updateChannel']);
    raw.close();
  });
});
