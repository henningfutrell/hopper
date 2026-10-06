// The oidc realm: OpenID Connect (any compliant issuer: Google, Microsoft Entra, Okta, Auth0, Keycloak, …) through
// openid-client: discovery, authorization code with PKCE, state and nonce, ID token validation,
// then userinfo for the claims the ID token left out.
import * as client from 'openid-client';
import type { Identity } from '../domain/types.ts';
import type { OidcRealmConfig } from './config.ts';
import { isLoopbackHttp, stringList, stringOf, type RedirectRealm } from './realm.ts';

export function createOidcRealm(c: OidcRealmConfig, redirectUri: string): RedirectRealm {
  let discovered: Promise<client.Configuration> | undefined;
  // Discovered on first use, not at boot: an unreachable issuer must not stop the daemon. A failure is retried next time.
  const config = (): Promise<client.Configuration> => {
    discovered ??= client.discovery(new URL(c.issuer), c.clientId, c.clientSecret === undefined ? undefined : { client_secret: c.clientSecret },
      c.clientSecret === undefined ? client.None() : undefined,
      isLoopbackHttp(c.issuer) ? { execute: [client.allowInsecureRequests] } : undefined)
      .catch((e: unknown) => { discovered = undefined; throw new Error(`OIDC discovery at ${c.issuer} failed: ${(e as Error).message}`); });
    return discovered;
  };
  return {
    name: c.name, label: c.label, type: 'oidc',
    async start(flowId) {
      const verifier = client.randomPKCECodeVerifier();
      const nonce = client.randomNonce();
      const url = client.buildAuthorizationUrl(await config(), {
        redirect_uri: redirectUri, scope: c.scopes.join(' '), state: flowId, nonce,
        code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
      });
      return { url: url.href, secrets: { verifier, nonce, state: flowId } };
    },
    flowIdOf: (cb) => cb.url.searchParams.get('state') ?? undefined,
    async finish(cb, secrets) {
      const cfg = await config();
      const tokens = await client.authorizationCodeGrant(cfg, cb.url, {
        pkceCodeVerifier: secrets.verifier!, expectedState: secrets.state!, expectedNonce: secrets.nonce!, idTokenExpected: true,
      }, { redirect_uri: redirectUri });
      const idClaims = tokens.claims()!;
      const info = cfg.serverMetadata().userinfo_endpoint ? await client.fetchUserInfo(cfg, tokens.access_token, idClaims.sub) : {};
      // The ID token is signed and checked; userinfo only fills what it lacks.
      const claims: Record<string, unknown> = { ...info, ...idClaims };
      const email = stringOf(claims[c.claims.email]);
      const verified = c.trustUnverifiedEmail || claims.email_verified === true;
      const who: Identity = { realm: c.name, subject: idClaims.sub, groups: stringList(claims[c.claims.groups]) };
      const username = stringOf(claims[c.claims.username]);
      const name = stringOf(claims[c.claims.name]);
      return { ...who, ...(email && verified ? { email } : {}), ...(username ? { username } : {}), ...(name ? { name } : {}) };
    },
  };
}
