// Grants (issue #881, design.md "Grants and refresh tokens"): a person mints a grant once; its agent trades the refresh
// token for a short-lived API token and a new refresh token, again and again. A spent refresh token is answered the
// same pair within the grace period, and ends the whole grant after it. A grant dies when unused for 30 days, at its
// fixed end, when revoked, or when its minter's sign-in grants no role. The real store and the real UI sessions; only
// the clock and the sign-in's role are the test's.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InstanceStore } from '../../src/domain/ports.ts';
import type { Identity, UiRole } from '../../src/domain/types.ts';
import { createApiGrants, type ApiGrants, type GrantRecord, type GrantWanted } from '../../src/http/ui/api-grants.ts';
import { CLI_REALM, createUiSessions, type UiSessions } from '../../src/http/ui/sessions.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { openDb } from '../../src/store/db.ts';
import { fixedClock, useTempStore } from '../store/helpers.ts';

const t = useTempStore();
const MINUTE = 60_000;
const DAY = 86_400_000;
const ada: Identity = { realm: 'dir', subject: 'ada', groups: [] };

let url: string;
let instance: InstanceStore;
let sessions: UiSessions;
let grants: ApiGrants;
let records: GrantRecord[];
let role: UiRole | null;
const clock = fixedClock();
let start: number;
const at = (ms: number) => clock.set(new Date(start + ms).toISOString());

/** The service as a (re)start makes it: the same store, nothing in memory. */
function startService(): void {
  const signIn = { config: () => ({ sessions: { idleHours: 24 * 365, maxHours: 24 * 400 }, realms: [] }), checkGateway: async () => ({ ok: false as const, status: 401, error: 'no' }) };
  sessions = createUiSessions({ repo: instance.uiSessions, clock, signIn: signIn as never });
  grants = createApiGrants({ repo: instance.apiGrants, sessions, clock, roleOf: () => role, recorded: (_, r) => records.push(r) });
}

const want = (o: Partial<GrantWanted> = {}): GrantWanted => ({ userId: 'admin', identity: ada, role: 'operator', label: 'Grok Bot', holder: 'grok-bot', scopes: ['*:read'], box: true, days: 90, ...o });

beforeEach(() => {
  start = Date.parse('2026-10-12T10:00:00.000Z');
  at(0);
  url = t.url();
  instance = openInstanceStore({ url, clock });
  records = [];
  role = 'admin';
  startService();
});
afterEach(() => instance.close());

describe('a grant', () => {
  it('is minted with a refresh token and an API token; only their hashes are kept', () => {
    const m = grants.mint(want(), '127.0.0.1');
    expect(m.refresh).toMatch(/^hopper_rt_[0-9a-f]{64}$/);
    expect(m.token).toMatch(/^hopper_at_[0-9a-f]{64}$/);
    expect(Date.parse(m.expiresAt) - start).toBe(10 * MINUTE);
    expect(m.view).toMatchObject({ id: m.grant, label: 'Grok Bot', holder: 'grok-bot', role: 'operator', box: true, scopes: ['*:read'], endsAt: new Date(start + 90 * DAY).toISOString() });
    expect(sessions.find(m.token)).toMatchObject({ kind: 'api', grantId: m.grant, box: true, role: 'operator' });
    // A grant's API token is the grant's: it is not listed as an API token of its own.
    expect(sessions.apiTokens('admin')).toEqual([]);
    const raw = openDb(url);
    const stored = JSON.stringify([raw.all('SELECT * FROM api_grants'), raw.all('SELECT * FROM api_grant_tokens'), raw.all('SELECT * FROM ui_sessions')]);
    raw.close();
    expect(stored).not.toContain(m.refresh.slice('hopper_rt_'.length));
    expect(stored).not.toContain(m.token.slice('hopper_at_'.length));
    expect(records.map((r) => r.type)).toEqual(['api_grant.minted']);
  });

  it('a refresh rotates the refresh token; the one sent is spent', () => {
    const m = grants.mint(want(), '127.0.0.1');
    at(9 * MINUTE);
    const r = grants.refresh(m.refresh, '10.0.0.2');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.refresh).not.toBe(m.refresh);
    expect(r.value.token).not.toBe(m.token);
    expect(r.value.grant).toBe(m.grant);
    expect(grants.list('admin')[0]).toMatchObject({ lastUsedAt: new Date(start + 9 * MINUTE).toISOString(), lastUsedFrom: '10.0.0.2' });
    // The new pair works; the old API token runs to its own end.
    expect(sessions.find(r.value.token)).toBeDefined();
    expect(sessions.find(m.token)).toBeDefined();
    at(11 * MINUTE);
    expect(sessions.find(m.token)).toBeUndefined();
    expect(grants.refresh(r.value.refresh, '10.0.0.2').ok).toBe(true);
  });

  it('a refresh retried within the grace period gets the same pair', () => {
    const m = grants.mint(want(), '127.0.0.1');
    const first = grants.refresh(m.refresh, '10.0.0.2');
    at(20_000);
    const again = grants.refresh(m.refresh, '10.0.0.2');
    expect(again).toEqual(first);
    expect(grants.live(m.grant)).toBeDefined();
  });

  it('a spent refresh token sent after the grace period ends the whole grant and says so', () => {
    const m = grants.mint(want(), '127.0.0.1');
    const first = grants.refresh(m.refresh, '10.0.0.2');
    if (!first.ok) throw new Error('refused');
    at(31_000);
    const reused = grants.refresh(m.refresh, '203.0.113.7');
    expect(reused).toMatchObject({ ok: false, error: expect.stringMatching(/used before/) });
    expect(grants.live(m.grant)).toBeUndefined();
    expect(sessions.find(first.value.token)).toBeUndefined();
    expect(grants.refresh(first.value.refresh, '10.0.0.2').ok).toBe(false);
    expect(records.slice(-2)).toEqual([
      { type: 'api_grant.reuse_detected', data: { grant: m.grant, label: 'Grok Bot', holder: 'grok-bot', from: '203.0.113.7' } },
      { type: 'api_grant.revoked', data: { grant: m.grant, label: 'Grok Bot', holder: 'grok-bot', reason: 'reuse-detected' } },
    ]);
  });

  it('after a restart within the grace period, the spent token is refused but the grant stands', () => {
    const m = grants.mint(want(), '127.0.0.1');
    const first = grants.refresh(m.refresh, '10.0.0.2');
    if (!first.ok) throw new Error('refused');
    startService();
    at(5_000);
    expect(grants.refresh(m.refresh, '10.0.0.2')).toMatchObject({ ok: false, error: expect.stringMatching(/restarted/) });
    expect(grants.live(m.grant)).toBeDefined();
    expect(grants.refresh(first.value.refresh, '10.0.0.2').ok).toBe(true);
  });

  it('dies 30 days after its last refresh, and at its fixed end however much it is used', () => {
    const idle = grants.mint(want({ label: 'idle' }), '127.0.0.1');
    let used = grants.mint(want({ label: 'used', days: 40 }), '127.0.0.1');
    for (let day = 25; day < 50; day += 25) {
      at(day * DAY);
      const r = grants.refresh(used.refresh, '127.0.0.1');
      if (r.ok) used = { ...used, refresh: r.value.refresh };
    }
    at(30 * DAY);
    expect(grants.live(idle.grant)).toBeUndefined();
    expect(grants.live(used.grant)).toBeDefined();
    at(40 * DAY);
    expect(grants.live(used.grant)).toBeUndefined();
    expect(records.filter((r) => r.type === 'api_grant.revoked').map((r) => r.data)).toEqual([
      expect.objectContaining({ label: 'idle', reason: 'expired-idle' }), expect.objectContaining({ label: 'used', reason: 'expired-absolute' }),
    ]);
  });

  it('with no fixed end, lives while it is used', () => {
    let m = grants.mint(want({ days: null }), '127.0.0.1');
    expect(m.warning).toMatch(/no fixed end/);
    expect(m.view.endsAt).toBeNull();
    for (let day = 20; day <= 400; day += 20) {
      at(day * DAY);
      const r = grants.refresh(m.refresh, '127.0.0.1');
      if (!r.ok) throw new Error(`refused on day ${day}: ${r.error}`);
      m = { ...m, refresh: r.value.refresh };
    }
    expect(grants.live(m.grant)).toBeDefined();
  });

  it('API tokens live the admin\'s setting, or the grant\'s own shorter lifetime', () => {
    expect(grants.settings()).toEqual({ tokenMinutes: 10, min: 5, max: 15 });
    const own = grants.mint(want({ minutes: 7 }), '127.0.0.1');
    expect(Date.parse(own.expiresAt) - start).toBe(7 * MINUTE);
    expect(grants.setTokenMinutes(5)).toEqual({ tokenMinutes: 5, min: 5, max: 15 });
    const r = grants.refresh(own.refresh, '127.0.0.1');
    if (!r.ok) throw new Error('refused');
    expect(Date.parse(r.value.expiresAt) - start).toBe(5 * MINUTE);
    // An API token there is keeps its own end.
    expect(sessions.find(own.token)?.expiresAt).toBe(own.expiresAt);
    grants.setTokenMinutes(15);
    expect(Date.parse(grants.mint(want(), '127.0.0.1').expiresAt) - start).toBe(15 * MINUTE);
  });

  it('its minter\'s rights are asked at each refresh: lower lowers it, none ends it', () => {
    const m = grants.mint(want({ role: 'operator' }), '127.0.0.1');
    role = 'viewer';
    const r = grants.refresh(m.refresh, '127.0.0.1');
    if (!r.ok) throw new Error('refused');
    expect(sessions.find(r.value.token)?.role).toBe('viewer');
    // A higher role does not raise it.
    role = 'admin';
    const r2 = grants.refresh(r.value.refresh, '127.0.0.1');
    if (!r2.ok) throw new Error('refused');
    expect(sessions.find(r2.value.token)?.role).toBe('viewer');
    role = null;
    expect(grants.refresh(r2.value.refresh, '127.0.0.1')).toMatchObject({ ok: false, error: expect.stringMatching(/no role/) });
    expect(grants.live(m.grant)).toBeUndefined();
  });

  it('a sign-in change applies to grants as to sessions; the operator CLI\'s grant keeps its role', () => {
    const dir = grants.mint(want(), '127.0.0.1');
    const cli = grants.mint(want({ identity: { realm: CLI_REALM, subject: 'operator-cli', groups: [] } }), '127.0.0.1');
    expect(grants.reconcile(() => null)).toEqual({ dropped: 1, changed: 0 });
    expect(grants.live(dir.grant)).toBeUndefined();
    expect(sessions.find(dir.token)).toBeUndefined();
    expect(grants.live(cli.grant)).toBeDefined();
  });

  it('revoked, it ends with its API tokens; revoke-all ends every grant of the user', () => {
    const a = grants.mint(want({ label: 'a' }), '127.0.0.1');
    const b = grants.mint(want({ label: 'b' }), '127.0.0.1');
    const other = grants.mint(want({ userId: 'bob' }), '127.0.0.1');
    expect(grants.revoke('bob', a.grant)).toBe(false);
    expect(grants.revoke('admin', a.grant)).toBe(true);
    expect(sessions.find(a.token)).toBeUndefined();
    expect(grants.refresh(a.refresh, '127.0.0.1').ok).toBe(false);
    expect(grants.list('admin').map((g) => g.label)).toEqual(['b']);
    expect(grants.revokeAll('admin')).toBe(1);
    expect(sessions.find(b.token)).toBeUndefined();
    expect(grants.list('admin')).toEqual([]);
    expect(grants.live(other.grant)).toBeDefined();
  });
});
