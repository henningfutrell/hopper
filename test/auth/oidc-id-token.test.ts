// The oidc realm checks the ID token's signature against the issuer's published keys (JWKS), and its `iss`,
// `aud`, `exp` and `nonce` (issue #1380, docs/sign-in.md "How an OIDC sign-in is checked"). A rotated key is
// read without a person: an unknown key id makes the realm read the JWKS again (after a short wait, so a
// stream of bad tokens cannot flood the issuer), and a removed key stops working once the realm reads the
// JWKS again (at the latest five minutes after the last read).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOidcRealm } from '../../src/auth/oidc.ts';
import type { OidcRealmConfig } from '../../src/auth/config.ts';
import type { RedirectRealm } from '../../src/auth/realm.ts';
import { startTestIssuer, type TestIssuer } from '../support/oidc-issuer.ts';

const CLIENT = 'hopper';
const REDIRECT = 'http://localhost:1/ui/auth/corp/callback';
let issuer: TestIssuer | undefined;
afterEach(async () => { vi.useRealTimers(); await issuer?.stop(); issuer = undefined; });

function realmOf(t: TestIssuer): RedirectRealm {
  const c: OidcRealmConfig = {
    name: 'corp', label: 'Corp SSO', type: 'oidc', enabled: true, issuer: t.issuer, clientId: CLIENT, scopes: ['openid', 'email'],
    claims: { email: 'email', username: 'preferred_username', name: 'name', groups: 'groups' }, trustUnverifiedEmail: false, roles: {},
  };
  return createOidcRealm(c, REDIRECT);
}

/** One whole sign-in: start, the issuer's redirect back, finish. */
async function signIn(realm: RedirectRealm, flowId = 'flow-1') {
  const { url, secrets } = await realm.start(flowId);
  const atIssuer = await fetch(url, { redirect: 'manual' });
  return realm.finish({ url: new URL(atIssuer.headers.get('location')!) }, secrets);
}

/** Moves the clock (Date only) on by `seconds`. */
const later = (seconds: number) => { vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + seconds * 1000 }); };

describe('the ID token of an OIDC sign-in', () => {
  it('signed by a published key, for this client, from this issuer: the identity, with its verified email', async () => {
    issuer = await startTestIssuer(CLIENT);
    const who = await signIn(realmOf(issuer));
    expect(who).toMatchObject({ realm: 'corp', subject: 'ada-1', email: 'ada@example.com' });
    expect(issuer.jwksReads).toBe(1);
  });

  it('signed by a key the issuer does not publish: refused', async () => {
    issuer = await startTestIssuer(CLIENT);
    const stranger = await issuer.newKey();
    // The same key id as the published key, so only the signature can tell them apart.
    issuer.signWith = { ...stranger, kid: issuer.published[0]!.kid };
    await expect(signIn(realmOf(issuer))).rejects.toThrow(/signature/i);
  });

  it('from another issuer (iss): refused', async () => {
    issuer = await startTestIssuer(CLIENT);
    issuer.claims = { iss: 'https://evil.example' };
    await expect(signIn(realmOf(issuer))).rejects.toThrow(/iss/);
  });

  it('for another client (aud): refused', async () => {
    issuer = await startTestIssuer(CLIENT);
    issuer.claims = { aud: 'someone-else' };
    await expect(signIn(realmOf(issuer))).rejects.toThrow(/aud/);
  });

  it('expired (exp): refused', async () => {
    issuer = await startTestIssuer(CLIENT);
    const past = Math.floor(Date.now() / 1000) - 3600;
    issuer.claims = { iat: past - 60, exp: past };
    await expect(signIn(realmOf(issuer))).rejects.toThrow(/exp/);
  });

  it('with another nonce: refused', async () => {
    issuer = await startTestIssuer(CLIENT);
    issuer.claims = { nonce: 'not-this-sign-in' };
    await expect(signIn(realmOf(issuer))).rejects.toThrow(/nonce/);
  });

  it('a rotated key is picked up without a person: the realm reads the JWKS again for a key id it does not know', async () => {
    issuer = await startTestIssuer(CLIENT);
    const realm = realmOf(issuer);
    await signIn(realm, 'flow-1');
    const next = await issuer.newKey();
    issuer.published = [...issuer.published, next];
    issuer.signWith = next;
    later(61);
    expect(await signIn(realm, 'flow-2')).toMatchObject({ subject: 'ada-1' });
    expect(issuer.jwksReads).toBe(2);
  });

  it('a removed key stops working once the realm reads the JWKS again', async () => {
    issuer = await startTestIssuer(CLIENT);
    const realm = realmOf(issuer);
    const old = issuer.published[0]!;
    await signIn(realm, 'flow-1');
    const next = await issuer.newKey();
    issuer.published = [next];
    // Still signed with the old key, which the issuer no longer publishes.
    later(301);
    await expect(signIn(realm, 'flow-2')).rejects.toThrow(/key/i);
    expect(issuer.jwksReads).toBeGreaterThanOrEqual(2);
    issuer.signWith = next;
    expect(await signIn(realm, 'flow-3')).toMatchObject({ subject: 'ada-1' });
    expect(old.kid).not.toBe(next.kid);
  });

  it('an unverified email is left out of the identity', async () => {
    issuer = await startTestIssuer(CLIENT);
    issuer.claims = { email_verified: false };
    const who = await signIn(realmOf(issuer));
    expect(who.email).toBeUndefined();
  });
});
