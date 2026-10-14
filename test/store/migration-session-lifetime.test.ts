// The migration that gives UI sessions an idle timeout and an absolute maximum (issue #439): a session no
// longer carries a fixed expiry; it carries when it started, when it was last used and when its gateway token
// was last checked, and the sign-in config's lengths decide when it ends. A session live at the migration
// stays signed in, counted from the migration; one already expired is gone, as it would have been.
import { describe, expect, it } from 'vitest';
import { openInstanceStore } from '../../src/store/index.ts';
import { fixedClock, useTempStore } from './helpers.ts';

const t = useTempStore();
const BEFORE = 26;

describe('migration: sessions renew', () => {
  it('a live session stays, counted from the migration; an expired one is gone', () => {
    const url = t.url();
    openInstanceStore({ url, clock: fixedClock(), version: BEFORE }).close();
    const raw = t.at(url, BEFORE);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 1000).toISOString();
    raw.run("INSERT INTO ui_sessions (token_hash, expires_at, role, identity, user_id) VALUES ('live', ?, 'admin', '{\"realm\":\"local\",\"subject\":\"local\",\"groups\":[]}', 'u1')", future);
    raw.run("INSERT INTO ui_sessions (token_hash, expires_at, role, identity, user_id) VALUES ('gone', ?, 'viewer', '{\"realm\":\"local\",\"subject\":\"local\",\"groups\":[]}', 'u1')", past);
    raw.close();

    const before = Date.now();
    const instance = openInstanceStore({ url, clock: fixedClock() });
    try {
      const rows = instance.uiSessions.all();
      expect(rows.map((r) => r.tokenHash)).toEqual(['live']);
      const live = rows[0]!;
      expect(Date.parse(live.startedAt)).toBeGreaterThanOrEqual(before - 1000);
      expect(live.lastSeenAt).toBe(live.startedAt);
      expect(live.checkedAt).toBe(live.startedAt);
      expect(live).not.toHaveProperty('endsAt');
      expect(live).toMatchObject({ role: 'admin', userId: 'u1', identity: { realm: 'local' } });
    } finally {
      instance.close();
    }
  });
});
