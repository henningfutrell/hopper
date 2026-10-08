// How long a UI session lasts (issue #439, docs/sign-in.md "Sessions and logout"): the hopper's own session,
// renewed by activity, with an idle timeout and an absolute maximum from the sign-in config — read at each
// lookup, so a change applies to the sessions there are. A session made by a gateway realm renews only while
// the token the gateway forwards still checks out. Every end is reported with its reason. The real store
// and the real sign-in (a loopback issuer for the gateway); only the clock is set by the test.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSignIn, loadSignInConfig, type SignIn } from '../../src/auth/index.ts';
import type { InstanceStore } from '../../src/domain/ports.ts';
import type { Identity } from '../../src/domain/types.ts';
import { createUiSessions, type EndedSession, type UiSessions } from '../../src/http/ui/sessions.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { startOidcIdp, type OidcIdp } from '../support/idp.ts';
import { fixedClock, useTempStore } from '../store/helpers.ts';

const t = useTempStore();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ada: Identity = { realm: 'dir', subject: 'ada', groups: [] };
const edgeAda: Identity = { realm: 'edge', subject: 'ada-1', groups: [] };

const githubAda: Identity = { realm: 'github', subject: '1', username: 'ada', groups: [] };

const gatewayRealm = (issuer: string) => ({ name: 'edge', type: 'gateway', issuer, audience: ['hopper'], roles: { defaultRole: 'viewer' } });
const ldapRealm = { name: 'dir', type: 'ldap', url: 'ldap://127.0.0.1:1', userBase: 'ou=people,dc=example,dc=org', roles: { defaultRole: 'viewer' } };

let instance: InstanceStore;
let signIn: SignIn;
let sessions: UiSessions;
let ended: EndedSession[];
let idp: OidcIdp;
const clock = fixedClock(new Date().toISOString());
const at = (ms: number) => clock.set(new Date(start + ms).toISOString());
let start: number;

/** The users whose GitHub connection ended (issue #513). */
let connectionEnded: Set<string>;

function setUp(o: { idleHours?: number; maxHours?: number; issuer?: string } = {}) {
  const config = loadSignInConfig({
    version: 1, sessions: { idleHours: o.idleHours ?? 168, maxHours: o.maxHours ?? 720 },
    realms: [ldapRealm, gatewayRealm(o.issuer ?? idp.issuer), { name: 'github', type: 'github' }],
  });
  signIn = createSignIn({ config, clock, origin: () => 'http://localhost:1' });
  sessions = createUiSessions({
    repo: instance.uiSessions, clock, signIn, ended: (s) => ended.push(s), connectionEnded: (userId) => connectionEnded.has(userId),
  });
}

beforeEach(async () => {
  start = Date.now();
  clock.set(new Date(start).toISOString());
  instance = openInstanceStore({ url: t.url(), clock });
  ended = [];
  connectionEnded = new Set();
  idp = await startOidcIdp();
});
afterEach(async () => {
  instance.close();
  await idp.stop();
});

const forwarded = async (claims: Record<string, unknown> = {}) => ({ authorization: `Bearer ${await idp.token({ sub: 'ada-1', aud: 'hopper', ...claims }, 300)}` });

describe('a session the hopper owns', () => {
  it('lasts past the old fixed 12 hours: 7 days idle by default', () => {
    setUp();
    const s = sessions.create({ role: 'admin', identity: ada, userId: 'u1' });
    at(13 * HOUR);
    expect(sessions.find(s.token)?.userId).toBe('u1');
    expect(sessions.find(s.token)?.expiresAt).toBe(new Date(start + 7 * DAY).toISOString());
  });

  it('activity before the idle timeout renews it: it slides', async () => {
    setUp();
    const s = sessions.create({ role: 'admin', identity: ada, userId: 'u1' });
    at(6 * DAY);
    await sessions.renew(s.token, {});
    at(12 * DAY);
    expect(sessions.find(s.token)).toBeDefined();
    expect(sessions.find(s.token)?.expiresAt).toBe(new Date(start + 13 * DAY).toISOString());
    await sessions.renew(s.token, {});
    at(18 * DAY);
    expect(sessions.find(s.token)).toBeDefined();
    expect(ended).toEqual([]);
  });

  it('no activity for the idle timeout ends it, as expired-idle', () => {
    setUp();
    const s = sessions.create({ role: 'admin', identity: ada, userId: 'u1' });
    at(7 * DAY);
    expect(sessions.find(s.token)).toBeUndefined();
    expect(ended).toEqual([{ userId: 'u1', identity: ada, reason: 'expired-idle' }]);
    expect(instance.uiSessions.all()).toEqual([]);
  });

  it('activity never takes it past the absolute maximum: expired-absolute', async () => {
    setUp();
    const s = sessions.create({ role: 'admin', identity: ada, userId: 'u1' });
    for (let d = 1; d < 30; d++) {
      at(d * DAY);
      await sessions.renew(s.token, {});
    }
    at(30 * DAY - 1000);
    expect(sessions.find(s.token)?.expiresAt).toBe(new Date(start + 30 * DAY).toISOString());
    at(30 * DAY);
    expect(sessions.find(s.token)).toBeUndefined();
    expect(ended).toEqual([{ userId: 'u1', identity: ada, reason: 'expired-absolute' }]);
  });

  it('a changed setting applies to the sessions there are, without a restart', async () => {
    setUp();
    const s = sessions.create({ role: 'admin', identity: ada, userId: 'u1' });
    at(2 * HOUR);
    expect(sessions.find(s.token)).toBeDefined();
    signIn.apply(loadSignInConfig({ version: 1, sessions: { idleHours: 1, maxHours: 720 }, realms: [ldapRealm] }));
    expect(sessions.find(s.token)).toBeUndefined();
    expect(ended.map((e) => e.reason)).toEqual(['expired-idle']);
    // A new one gets the new length.
    const next = sessions.create({ role: 'admin', identity: ada, userId: 'u1' });
    expect(next.expiresAt).toBe(new Date(start + 3 * HOUR).toISOString());
  });

  it('an expired session no request names still ends, with its reason', () => {
    setUp();
    sessions.create({ role: 'admin', identity: ada, userId: 'u1' });
    const other = sessions.create({ role: 'viewer', identity: ada, userId: 'u2' });
    at(8 * DAY);
    expect(sessions.find(other.token)).toBeUndefined();
    expect(ended.map((e) => [e.userId, e.reason]).sort()).toEqual([['u1', 'expired-idle'], ['u2', 'expired-idle']]);
  });

  it('logout and a changed sign-in config end it, each with its reason', () => {
    setUp();
    const a = sessions.create({ role: 'admin', identity: ada, userId: 'u1' });
    sessions.create({ role: 'admin', identity: edgeAda, userId: 'u2' });
    sessions.drop(a.token, 'logout');
    sessions.reconcile((who) => (who.realm === 'edge' ? null : 'admin'));
    expect(ended).toEqual([
      { userId: 'u1', identity: ada, reason: 'logout' },
      { userId: 'u2', identity: edgeAda, reason: 'realm-changed' },
    ]);
  });

  it('a session made with its own end (the operator CLI\'s) ends then, whatever the settings', () => {
    setUp();
    const s = sessions.create({ role: 'admin', identity: ada, userId: 'u1', lastsMs: 5 * 60_000 });
    expect(s.expiresAt).toBe(new Date(start + 5 * 60_000).toISOString());
    at(5 * 60_000);
    expect(sessions.find(s.token)).toBeUndefined();
    expect(ended.map((e) => e.reason)).toEqual(['expired-absolute']);
  });
});

describe('a session a gateway realm made: the gateway stays the authority', () => {
  it('renews while the forwarded token checks out', async () => {
    setUp();
    const s = sessions.create({ role: 'viewer', identity: edgeAda, userId: 'u1' });
    at(6 * DAY);
    await sessions.renew(s.token, await forwarded());
    at(12 * DAY);
    expect(sessions.find(s.token)).toBeDefined();
  });

  it('a token the issuer refuses on renewal ends it: refresh-refused', async () => {
    setUp();
    const s = sessions.create({ role: 'viewer', identity: edgeAda, userId: 'u1' });
    at(HOUR);
    await sessions.renew(s.token, await forwarded({ exp: Math.floor(Date.now() / 1000) - 3600 }));
    expect(sessions.find(s.token)).toBeUndefined();
    expect(ended).toEqual([{ userId: 'u1', identity: edgeAda, reason: 'refresh-refused' }]);
  });

  it('no token on the request, or one for someone else, ends it too', async () => {
    setUp();
    const a = sessions.create({ role: 'viewer', identity: edgeAda, userId: 'u1' });
    const b = sessions.create({ role: 'viewer', identity: edgeAda, userId: 'u2' });
    at(HOUR);
    await sessions.renew(a.token, {});
    await sessions.renew(b.token, await forwarded({ sub: 'bob-2' }));
    expect(ended.map((e) => [e.userId, e.reason])).toEqual([['u1', 'refresh-refused'], ['u2', 'refresh-refused']]);
  });

  it('an issuer that cannot be reached briefly does not end it; past the grace period it does', async () => {
    setUp();
    const s = sessions.create({ role: 'viewer', identity: edgeAda, userId: 'u1' });
    signIn.apply(loadSignInConfig({ version: 1, realms: [gatewayRealm('http://127.0.0.1:9/')] }));
    at(2 * 60_000);
    await sessions.renew(s.token, await forwarded());
    expect(sessions.find(s.token)).toBeDefined();
    at(4 * 60_000);
    await sessions.renew(s.token, await forwarded());
    expect(sessions.find(s.token)).toBeDefined();
    at(6 * 60_000);
    await sessions.renew(s.token, await forwarded());
    expect(sessions.find(s.token)).toBeUndefined();
    expect(ended).toEqual([{ userId: 'u1', identity: edgeAda, reason: 'provider-unreachable' }]);
  });

  it('an unreachable issuer does not slide it: the idle timeout still counts from the last good check', async () => {
    setUp({ idleHours: 1 });
    const s = sessions.create({ role: 'viewer', identity: edgeAda, userId: 'u1' });
    signIn.apply(loadSignInConfig({ version: 1, sessions: { idleHours: 1, maxHours: 720 }, realms: [gatewayRealm('http://127.0.0.1:9/')] }));
    at(3 * 60_000);
    await sessions.renew(s.token, await forwarded());
    expect(sessions.find(s.token)?.expiresAt).toBe(new Date(start + HOUR).toISOString());
  });
});

describe('a session signed in with GitHub, when the GitHub connection ends (issue #513)', () => {
  it('ends every GitHub sign-in of that user, as connection-ended; the next lookup finds none', () => {
    setUp();
    const a = sessions.create({ role: 'admin', identity: githubAda, userId: 'u1' });
    const b = sessions.create({ role: 'admin', identity: githubAda, userId: 'u1' });
    expect(sessions.find(a.token)).toBeDefined();
    connectionEnded.add('u1');
    expect(sessions.find(a.token)).toBeUndefined();
    expect(sessions.find(b.token)).toBeUndefined();
    expect(ended).toEqual([
      { userId: 'u1', identity: githubAda, reason: 'connection-ended' },
      { userId: 'u1', identity: githubAda, reason: 'connection-ended' },
    ]);
  });

  it('a request renewing it ends it too, with nothing renewed', async () => {
    setUp();
    const s = sessions.create({ role: 'admin', identity: githubAda, userId: 'u1' });
    connectionEnded.add('u1');
    at(2 * 60_000);
    await sessions.renew(s.token, {});
    expect(ended.map((e) => e.reason)).toEqual(['connection-ended']);
  });

  it('keeps a session of that user signed in another way: it may connect GitHub again from Sources', () => {
    setUp();
    const s = sessions.create({ role: 'admin', identity: ada, userId: 'u1' });
    connectionEnded.add('u1');
    expect(sessions.find(s.token)?.userId).toBe('u1');
    expect(ended).toEqual([]);
  });

  it('keeps a GitHub sign-in whose connection lives, and another user\'s', () => {
    setUp();
    const mine = sessions.create({ role: 'admin', identity: githubAda, userId: 'u1' });
    const theirs = sessions.create({ role: 'viewer', identity: { ...githubAda, subject: '2', username: 'bob' }, userId: 'u2' });
    expect(sessions.find(mine.token)).toBeDefined();
    connectionEnded.add('u1');
    expect(sessions.find(theirs.token)?.userId).toBe('u2');
    expect(sessions.find(mine.token)).toBeUndefined();
    expect(ended.map((e) => e.userId)).toEqual(['u1']);
  });
});
