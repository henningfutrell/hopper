// The first gateway admin (issue #2996, docs/sign-in.md "The first gateway admin"): on a hopper only an auth gateway signs
// in to, a gateway realm with firstAdmin on makes the first identity it accepts admin while no admin exists, as the first
// GitHub sign-in does (issue #239). Off by default; recorded as a super admin; after that the rules grant the rest.
import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest } from '../support/http.ts';
import type { OidcIdp } from '../support/idp.ts';
import { harness, oidcIdp, restartSame, session, startNewHopper, stopAll } from '../support/sign-in-app.ts';

const h = harness();
afterEach(() => stopAll(h));

const realm = (idp: Pick<OidcIdp, 'issuer'>, extra: Record<string, unknown> = {}) =>
  ({ name: 'edge', label: 'Edge gateway', type: 'gateway', issuer: idp.issuer, audience: ['hopper'], roles: { admin: { usernames: ['nobody'] } }, ...extra });
const auth = (idp: Pick<OidcIdp, 'issuer'>, extra: Record<string, unknown> = {}) => ({ version: 1, local: { enabled: false }, realms: [realm(idp, extra)] });
const exchange = async (app: { url: string }, idp: OidcIdp, sub: string) => {
  const port = new URL(app.url).port;
  const token = await idp.token({ sub, aud: 'hopper', preferred_username: sub }, 300);
  return rawRequest(app.url, {
    method: 'POST', path: '/ui/auth/gateway', body: '{}',
    headers: { host: `localhost:${port}`, origin: `http://localhost:${port}`, 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
};
const tokenOf = (text: string): string => (JSON.parse(text) as { token: string }).token;

describe('the first gateway admin', () => {
  it('is off by default: a gateway identity no rule matches gets no session', async () => {
    const idp = await oidcIdp(h);
    const { app } = await startNewHopper(h, auth(idp));
    expect((await exchange(app, idp, 'ada-1')).status).toBe(403);
    expect(app.app.auth().superAdmins).toEqual([]);
  });

  it('on, the first identity the realm accepts becomes admin; the next gets what the rules grant; it holds after a restart', async () => {
    const idp = await oidcIdp(h);
    const { app } = await startNewHopper(h, auth(idp, { firstAdmin: true }));
    const first = await exchange(app, idp, 'ada-1');
    expect(first.status).toBe(200);
    expect((await session(app, tokenOf(first.text))).user.role).toBe('admin');
    expect(app.app.auth().superAdmins).toEqual([{ realm: 'edge', subject: 'ada-1' }]);
    const second = await exchange(app, idp, 'grace-1');
    expect(second.status).toBe(403);
    expect(JSON.parse(second.text).error).toMatch(/grants this account no role/);
    const again = await restartSame(h, app);
    expect((await exchange(again, idp, 'ada-1')).status).toBe(200);
    expect((await exchange(again, idp, 'grace-1')).status).toBe(403);
  }, 60_000);

  it('makes nobody admin while a session is admin', async () => {
    const idp = await oidcIdp(h);
    const { app } = await startNewHopper(h, { ...auth(idp, { firstAdmin: true }), local: { enabled: true } });
    await app.login();
    expect((await exchange(app, idp, 'ada-1')).status).toBe(403);
    expect(app.app.auth().superAdmins).toEqual([]);
  });
});
