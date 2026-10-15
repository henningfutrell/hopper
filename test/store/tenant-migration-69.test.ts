// Tenant migration 69 (issue #1377): GitHub through the sign-in alone. A config whose job sources hold no connected
// account's source gets one. Every `github-app` instance leaves the plugins config; the account's source takes its place
// (added when none is, switched on when the removed instance was on), and its jobs and source events, so no job and no
// intake state is lost; the work-item ledger is rebuilt from them; the App's key leaves the vault.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/store/db.ts';
import { migrateTenant } from '../../src/store/tenant-migrations.ts';
import { useTempStore } from './helpers.ts';

const t = useTempStore();
const KEY = 'https://github.com/o/r/issues/1';
const CARD = 'https://github.com/o/r/issues/2';

function at68(plugins?: unknown): Db {
  const raw = t.tenantAt(t.url(), 68);
  if (plugins !== undefined) raw.run("INSERT INTO config (name, value, updated_at) VALUES ('plugins', ?, 'x')", JSON.stringify(plugins));
  return raw;
}

const plugins = (raw: Db) => JSON.parse(String(raw.get("SELECT value FROM config WHERE name = 'plugins'")!.value)) as { jobSources: unknown[] };
const job = (raw: Db, id: string, source: string, kind: string, key = KEY) => raw.run('INSERT INTO jobs (id, status, created_at, source_key, body) VALUES (?, ?, ?, ?, ?)',
  id, 'running', '2026-10-15T10:00:00.000Z', key, JSON.stringify({ id, status: 'running', source: { source, kind, key, url: key, title: 'T', repo: 'o/r', number: 1 } }));
const event = (raw: Db, id: string, type: string, data: Record<string, unknown>) => raw.run('INSERT INTO events (id, type, at, data) VALUES (?, ?, ?, ?)',
  id, type, '2026-10-15T10:00:00.000Z', JSON.stringify(data));
const sourceOf = (raw: Db, id: string) => (JSON.parse(String(raw.get('SELECT body FROM jobs WHERE id = ?', id)!.body)) as { source: { source: string; kind: string } }).source;

describe('tenant migration 69: no GitHub App private key', () => {
  it('a config with only github-app: the instance goes, the account source comes, and the jobs, request cards and key move with it', () => {
    const raw = at68({ version: 1, jobSources: [{ name: 'github-app', plugin: 'github-app', options: { appId: 1, slug: 's', label: 'hopper' } }], executors: [{ name: 'test', plugin: 'test' }] });
    job(raw, 'j1', 'github-app', 'github-app');
    event(raw, 'e1', 'source.request_opened', { source: 'github-app', key: CARD, hash: 'h' });
    event(raw, 'e2', 'job.created', { source: 'github-app' });
    raw.run('INSERT INTO vault_secrets (id, name, sealed, body) VALUES (?, ?, ?, ?)', 'v1', 'system/github-app-private-key', 'sealed', '{}');
    raw.run('INSERT INTO vault_secrets (id, name, sealed, body) VALUES (?, ?, ?, ?)', 'v2', 'system/typesafe-api-key', 'sealed', '{}');
    migrateTenant(raw, 69);
    expect(plugins(raw)).toEqual({ version: 1, jobSources: [{ name: 'github-account', plugin: 'github-account' }], executors: [{ name: 'test', plugin: 'test' }] });
    expect(sourceOf(raw, 'j1')).toMatchObject({ source: 'github-account', kind: 'github-account' });
    expect(raw.all('SELECT status, source_key FROM jobs')).toEqual([{ status: 'running', source_key: KEY }]);
    const data = (id: string) => JSON.parse(String(raw.get('SELECT data FROM events WHERE id = ?', id)!.data)) as Record<string, unknown>;
    expect(data('e1')).toEqual({ source: 'github-account', key: CARD, hash: 'h' });
    expect(data('e2')).toEqual({ source: 'github-app' }); // only a source event names a source instance
    const card = raw.get('SELECT body FROM work_items WHERE key = ?', CARD);
    expect(JSON.parse(String(card!.body))).toMatchObject({ eventState: 'waiting_for_approval', requestSource: 'github-account' });
    expect(raw.all('SELECT name FROM vault_secrets ORDER BY name')).toEqual([{ name: 'system/typesafe-api-key' }]);
    raw.close();
  });

  it('beside an account source: that one takes the work, switched on when it was off and the app source was on', () => {
    const raw = at68({ version: 1, jobSources: [
      { name: 'mine', plugin: 'github-account', options: { enabled: false, label: 'work' } },
      { name: 'app', plugin: 'github-app', options: { appId: 1, slug: 's' } },
    ] });
    job(raw, 'j1', 'app', 'github-app');
    job(raw, 'j2', 'mine', 'github-account', CARD);
    migrateTenant(raw, 69);
    expect(plugins(raw).jobSources).toEqual([{ name: 'mine', plugin: 'github-account', options: { label: 'work' } }]);
    expect(sourceOf(raw, 'j1')).toMatchObject({ source: 'mine', kind: 'github-account' });
    expect(sourceOf(raw, 'j2')).toMatchObject({ source: 'mine', kind: 'github-account' });
    raw.close();
  });

  it('an account source switched off stays off when the app source was off too; a name taken by another plugin is not reused', () => {
    const raw = at68({ version: 1, jobSources: [
      { name: 'github-account', plugin: 'custom' },
      { name: 'app', plugin: 'github-app', options: { enabled: false } },
    ] });
    migrateTenant(raw, 69);
    expect(plugins(raw).jobSources).toEqual([{ name: 'github-account', plugin: 'custom' }, { name: 'github-account-2', plugin: 'github-account' }]);
    raw.close();
  });

  it('job sources with no account source: it is added, the others kept', () => {
    const raw = at68({ version: 1, jobSources: [{ name: 'custom', plugin: 'custom' }] });
    migrateTenant(raw, 69);
    expect(plugins(raw).jobSources).toEqual([{ name: 'custom', plugin: 'custom' }, { name: 'github-account', plugin: 'github-account' }]);
    raw.close();
  });

  it('an account source and no github-app instance, or no job sources section: the config stays as it is', () => {
    const none = at68({ version: 1, executors: [] });
    migrateTenant(none, 69);
    expect(plugins(none)).toEqual({ version: 1, executors: [] });
    none.close();
    const doc = { version: 1, jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: false } }] };
    const raw = at68(doc);
    job(raw, 'j1', 'github', 'github-account');
    migrateTenant(raw, 69);
    expect(plugins(raw)).toEqual(doc);
    expect(sourceOf(raw, 'j1')).toMatchObject({ source: 'github', kind: 'github-account' });
    raw.close();
  });

  it('no plugins config: nothing to move', () => {
    const raw = at68();
    migrateTenant(raw, 69);
    expect(raw.get("SELECT value FROM config WHERE name = 'plugins'")).toBeUndefined();
    raw.close();
  });
});
