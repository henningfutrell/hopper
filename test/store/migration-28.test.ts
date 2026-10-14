// Migration 28 (issue #527): the UI sessions table as the build before migration 27 reads and writes it, beside
// this build's. Migration 27 dropped `expires_at`; a hopper rolled back to that build on the same database then
// failed every request that made or looked up a session (the operator CLI's Run again among them). Each statement
// below is that build's own (src/store/ui-sessions.ts before issue #439).
import { describe, expect, it } from 'vitest';
import { openInstanceStore } from '../../src/store/index.ts';
import { openDb } from '../../src/store/db.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();
const IDENTITY = '{"realm":"local","subject":"local","groups":[]}';

describe('migration 28: UI sessions the build before still runs on', () => {
  it('a session made before the migration gets an expiry: its own end, else its start plus the default maximum', () => {
    const url = t.url();
    openInstanceStore({ url, clock: fixedClock(), version: 27 }).close();
    const raw = t.at(url, 27);
    raw.run("INSERT INTO ui_sessions (token_hash, started_at, last_seen_at, checked_at, ends_at, role, identity, user_id) VALUES ('cli', '2026-10-08T10:00:00.000Z', '2026-10-08T10:00:00.000Z', '2026-10-08T10:00:00.000Z', '2026-10-08T10:05:00.000Z', 'operator', ?, 'u1')", IDENTITY);
    raw.run("INSERT INTO ui_sessions (token_hash, started_at, last_seen_at, checked_at, role, identity, user_id) VALUES ('ui', '2026-10-08T10:00:00.000Z', '2026-10-08T11:00:00.000Z', '2026-10-08T10:00:00.000Z', 'admin', ?, 'u1')", IDENTITY);
    raw.close();

    openInstanceStore({ url, clock: fixedClock() }).close();
    const db = openDb(url);
    expect(db.all('SELECT token_hash, expires_at FROM ui_sessions ORDER BY token_hash')).toEqual([
      { token_hash: 'cli', expires_at: '2026-10-08T10:05:00.000Z' },
      { token_hash: 'ui', expires_at: '2026-11-07T10:00:00.000Z' },
    ]);
    db.close();
  });

  it('the build before makes, finds, sweeps and drops sessions; this build reads the one it made', () => {
    const url = t.url();
    const instance = openInstanceStore({ url, clock: fixedClock() });
    const old = openDb(url);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 1000).toISOString();
    old.run('INSERT INTO ui_sessions (token_hash, expires_at, role, identity, user_id) VALUES (?, ?, ?, ?, ?)', 'live', future, 'operator', IDENTITY, 'u1');
    old.run('INSERT INTO ui_sessions (token_hash, expires_at, role, identity, user_id) VALUES (?, ?, ?, ?, ?)', 'gone', past, 'viewer', IDENTITY, 'u1');
    old.run('DELETE FROM ui_sessions WHERE expires_at <= ?', new Date().toISOString());
    expect(old.get('SELECT * FROM ui_sessions WHERE token_hash = ?', 'live')).toMatchObject({ expires_at: future, role: 'operator' });
    old.run('UPDATE ui_sessions SET role = ? WHERE token_hash = ?', 'admin', 'live');

    const rows = instance.uiSessions.all();
    expect(rows.map((r) => r.tokenHash)).toEqual(['live']);
    expect(rows[0]).toMatchObject({ role: 'admin', userId: 'u1' });
    expect(Date.parse(rows[0]!.startedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(rows[0]!.lastSeenAt).toBe(rows[0]!.startedAt);
    old.run('DELETE FROM ui_sessions WHERE token_hash = ?', 'live');
    expect(instance.uiSessions.all()).toEqual([]);
    old.close();
    instance.close();
  });

  it('a session this build makes carries the expiry the build before reads: its absolute end', () => {
    const url = t.url();
    const instance = openInstanceStore({ url, clock: fixedClock() });
    instance.uiSessions.create({
      tokenHash: 'h', startedAt: '2026-10-08T10:00:00.000Z', lastSeenAt: '2026-10-08T10:00:00.000Z', checkedAt: '2026-10-08T10:00:00.000Z',
      role: 'admin', identity: { realm: 'local', subject: 'local', groups: [] }, userId: 'u1',
    }, '2026-11-07T10:00:00.000Z');
    const old = openDb(url);
    expect(old.get('SELECT expires_at FROM ui_sessions WHERE token_hash = ?', 'h')).toEqual({ expires_at: '2026-11-07T10:00:00.000Z' });
    old.close();
    instance.close();
  });
});
