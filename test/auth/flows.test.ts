// Pending sign-ins are capped (the start route needs no session): past the cap the oldest flow is
// evicted, never a refusal — a flood of starts must not lock real users out (design.md "Sign-in").
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSignIn } from '../../src/auth/index.ts';
import { startOidcIdp, type OidcIdp } from '../support/idp.ts';

let idp: OidcIdp | undefined;
afterEach(async () => { await idp?.stop(); idp = undefined; });

const binding = () => randomBytes(24).toString('base64url');

describe('pending sign-in flows', () => {
  it('past the cap a new start still works; the oldest pending flow is the one dropped', async () => {
    idp = await startOidcIdp();
    const signIn = createSignIn({
      clock: { now: () => new Date() }, origin: () => 'http://localhost:1', maxFlows: 3,
      config: { local: { enabled: true }, none: null, githubAdmin: null, superAdmins: [], realms: [{
        name: 'corp', label: 'corp', type: 'oidc', enabled: true, issuer: idp.issuer, clientId: 'c', scopes: ['openid'],
        claims: { email: 'email', username: 'preferred_username', name: 'name', groups: 'groups' }, trustUnverifiedEmail: false, roles: { defaultRole: 'viewer' },
      }] },
    });
    const urls: string[] = [];
    for (let i = 0; i < 5; i++) urls.push(await signIn.begin('corp', binding()));
    const state = (u: string) => new URL(u).searchParams.get('state')!;
    const callback = (u: string) => signIn.callback('corp', { url: new URL(`http://localhost:1/ui/auth/corp/callback?code=x&state=${state(u)}`) });
    expect(await callback(urls[0]!)).toMatchObject({ ok: false, status: 400 });
    expect(await callback(urls[1]!)).toMatchObject({ ok: false, status: 400 });
    // Still pending: the provider rejects the made-up code, not the flow lookup.
    expect(await callback(urls[4]!)).toMatchObject({ ok: false, status: 502 });
  });
});
