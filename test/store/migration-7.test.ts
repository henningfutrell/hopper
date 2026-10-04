// Migration 7 (issue #39): a UI session belongs to someone. A session stored before it was made
// from the login code, so it survives as admin, provider local.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore } from '../../src/store/index.ts';
import { tempDbPath } from '../support/app.ts';

let cleanup: () => void;
afterEach(() => cleanup());

describe('migration 7 (session role and identity)', () => {
  it('keeps every stored session, as admin through the login code', () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    openStore({ path: db.dbPath, clock: { now: () => new Date() } }).close();
    const raw = new DatabaseSync(db.dbPath);
    raw.exec("DROP TABLE ui_sessions; CREATE TABLE ui_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL); PRAGMA user_version = 6;");
    raw.prepare('INSERT INTO ui_sessions VALUES (?, ?)').run('h1', '2999-01-01T00:00:00.000Z');
    raw.close();
    const store = openStore({ path: db.dbPath, clock: { now: () => new Date() } });
    try {
      expect(store.uiSessions.find('h1', new Date().toISOString())).toEqual({
        tokenHash: 'h1', expiresAt: '2999-01-01T00:00:00.000Z', role: 'admin',
        identity: { provider: 'local', subject: 'local', name: 'login code', groups: [] },
      });
    } finally {
      store.close();
    }
  });
});
