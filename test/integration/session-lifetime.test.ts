// How long a UI session lasts, through the daemon (issue #439, docs/sign-in.md "Sessions and logout"): the idle
// timeout and the absolute maximum are settings of the sign-in config, edited in Settings → Sign-in and applied
// at once; every request a session makes renews it; a session made by a gateway realm renews only while the
// gateway's token checks out; and every end is a `ui_session.ended` event with its reason.
import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest } from '../support/http.ts';
import { harness, oidcIdp, session, startWithAuth, stopAll } from '../support/sign-in-app.ts';
import type { TestApp } from '../support/app.ts';

const h = harness();
afterEach(() => stopAll(h));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read loose JSON
const realms = async (app: TestApp, token: string): Promise<any> => (await app.api('GET', '/api/realms', undefined, { 'x-hopper-session': token })).body;
const change = async (app: TestApp, token: string, body: Record<string, unknown>) =>
  app.ui<{ error?: string; sessions?: unknown }>('/ui/api/realms', { ...body, version: (await realms(app, token)).version }, { token });
/** One read that carries the session: activity. */
const read = (app: TestApp, token: string) => app.api('GET', '/api/queue', undefined, { 'x-hopper-session': token });
const endedEvents = async (app: TestApp) => (await app.events()).filter((e) => e.type === 'ui_session.ended').map((e) => e.data);

describe('session lengths in Settings → Sign-in', () => {
  it('default to 7 days idle and 30 days at most, and are read with the realms', async () => {
    const o = await startWithAuth(h, { version: 1 });
    const token = await o.app.login();
    expect((await realms(o.app, token)).sessions).toEqual({ idleHours: 168, maxHours: 720 });
    const s = await session(o.app, token);
    const left = Date.parse(s.expiresAt) - Date.now();
    expect(left).toBeGreaterThan(167 * 3_600_000);
    expect(left).toBeLessThanOrEqual(168 * 3_600_000);
  });

  it('a change applies at once to the sessions there are, without a restart', async () => {
    const o = await startWithAuth(h, { version: 1 });
    const token = await o.app.login();
    const res = await change(o.app, token, { action: 'settings', sessions: { idleHours: 2, maxHours: 24 } });
    expect(res.status).toBe(200);
    expect((await realms(o.app, token)).sessions).toEqual({ idleHours: 2, maxHours: 24 });
    const left = Date.parse((await session(o.app, token)).expiresAt) - Date.now();
    expect(left).toBeLessThanOrEqual(2 * 3_600_000);
    expect(left).toBeGreaterThan(2 * 3_600_000 - 60_000);
  });

  it('an idle timeout longer than the maximum is refused, naming the field', async () => {
    const o = await startWithAuth(h, { version: 1 });
    const token = await o.app.login();
    const res = await change(o.app, token, { action: 'settings', sessions: { idleHours: 48, maxHours: 24 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sessions\.idleHours/);
  });
});

describe('renewal on activity', () => {
  // 1.8 s idle, 6 s at most: a session renews at most every tenth of its idle timeout.
  const short = { version: 1, sessions: { idleHours: 0.0005, maxHours: 6 / 3600 } };

  it('a session in use outlives its idle timeout; left alone it ends, as an expired-idle event', async () => {
    const o = await startWithAuth(h, short);
    const token = await o.app.login();
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      expect((await read(o.app, token)).status).toBe(200);
    }
    expect((await session(o.app, token)).authenticated).toBe(true);
    await sleep(2200);
    expect((await session(o.app, token)).authenticated).toBe(false);
    expect(await endedEvents(o.app)).toEqual([{ reason: 'expired-idle', realm: 'local' }]);
  });

  it('in use, it still ends at the maximum', async () => {
    const o = await startWithAuth(h, short);
    const token = await o.app.login();
    const until = Date.now() + 6500;
    while (Date.now() < until) { await read(o.app, token); await sleep(400); }
    expect((await session(o.app, token)).authenticated).toBe(false);
    expect(await endedEvents(o.app)).toEqual([{ reason: 'expired-absolute', realm: 'local' }]);
  });

  it('a mutation refused for an ended session answers so, and logout is an event too', async () => {
    const o = await startWithAuth(h, { version: 1 });
    const token = await o.app.login();
    expect((await o.app.ui('/ui/api/logout', {}, { token })).status).toBe(200);
    expect((await o.app.ui('/ui/api/queue-gate', { mode: 'review', autoAcceptPerHour: null }, { token })).status).toBe(403);
    expect(await endedEvents(o.app)).toEqual([{ reason: 'logout', realm: 'local' }]);
  });
});

describe('a gateway realm stays the authority', () => {
  it('a session from the gateway ends once the token it forwards is refused', async () => {
    const idp = await oidcIdp(h);
    const o = await startWithAuth(h, {
      version: 1, sessions: { idleHours: 0.001, maxHours: 1 },
      realms: [{ name: 'edge', type: 'gateway', issuer: idp.issuer, audience: ['hopper'], roles: { defaultRole: 'viewer' } }],
    });
    const good = { authorization: `Bearer ${await idp.token({ sub: 'ada-1', aud: 'hopper' }, 300)}` };
    const res = await rawRequest(o.app.url, { method: 'POST', path: '/ui/auth/gateway', body: '{}', headers: { host: o.host, origin: o.origin, 'content-type': 'application/json', ...good } });
    const token = (JSON.parse(res.text) as { token: string }).token;
    await sleep(500);
    expect((await o.app.api('GET', '/api/queue', undefined, { 'x-hopper-session': token, ...good })).status).toBe(200);
    const user = (await session(o.app, token)).user.id as string;
    await sleep(500);
    const expired = { authorization: `Bearer ${await idp.token({ sub: 'ada-1', aud: 'hopper' }, -120)}` };
    await o.app.api('GET', '/api/queue', undefined, { 'x-hopper-session': token, ...expired });
    expect((await session(o.app, token)).authenticated).toBe(false);
    // The gateway's person signs in as a user of their own: the event is theirs.
    expect(o.app.user(user).store.events.recent(10, ['ui_session.ended']).map((e) => e.data)).toEqual([{ reason: 'refresh-refused', realm: 'edge' }]);
  });
});
