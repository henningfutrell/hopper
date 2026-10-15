// The oidc realm: OpenID Connect (any compliant issuer: Google, Microsoft Entra, Okta, Auth0, Keycloak, …) through
// openid-client: discovery, authorization code with PKCE, state and nonce, ID token validation,
// then userinfo for the claims the ID token left out. The ID token's signature is checked against the
// issuer's published keys (its JWKS, issue #1380) as well as its `iss`, `aud`, `exp` and `nonce`: openid-client
// leaves the signature unchecked for a token it got straight from the token endpoint unless told to. Its JWKS
// cache reads the keys again for a key id it does not know (at most once a minute) and at the latest five
// minutes after the last read, so a rotated key needs no person and a removed key stops working.
import * as client from 'openid-client';
import type { OidcRealmConfig } from './config.ts';
import { claimsIdentity, isLoopbackHttp, type RedirectRealm } from './realm.ts';

export function createOidcRealm(c: OidcRealmConfig, redirectUri: string): RedirectRealm {
  let discovered: Promise<client.Configuration> | undefined;
  // Discovered on first use, not at boot: an unreachable issuer must not stop the daemon. A failure is retried next time.
  const config = (): Promise<client.Configuration> => {
    discovered ??= client.discovery(new URL(c.issuer), c.clientId, c.clientSecret === undefined ? undefined : { client_secret: c.clientSecret },
      c.clientSecret === undefined ? client.None() : undefined,
      { execute: [client.enableNonRepudiationChecks, ...(isLoopbackHttp(c.issuer) ? [client.allowInsecureRequests] : [])] })
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
      }, { redirect_uri: redirectUri }).catch((e: unknown) => { throw new Error(why(e)); });
      const idClaims = tokens.claims()!;
      const info = cfg.serverMetadata().userinfo_endpoint ? await client.fetchUserInfo(cfg, tokens.access_token, idClaims.sub) : {};
      // The ID token is signed and checked; userinfo only fills what it lacks.
      const claims: Record<string, unknown> = { ...info, ...idClaims };
      return claimsIdentity(c.name, idClaims.sub, claims, c.claims, c.trustUnverifiedEmail);
    },
  };
}

/** openid-client's error with the cause it wraps, which names the claim or the key: `unexpected JWT claim value encountered: unexpected JWT "aud" (audience) claim value`. */
function why(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : undefined;
  return cause && cause !== message ? `${message}: ${cause}` : message;
}
