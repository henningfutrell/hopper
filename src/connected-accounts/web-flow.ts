// GitHub's web flow for the hopper's GitHub App (issue #258): the browser goes to GitHub and comes back
// with a code — authorization code with PKCE, through openid-client, as the OIDC realms are. GitHub is no
// OpenID provider, so its two endpoints are named here, not discovered. GitHub takes the app's client
// secret for the exchange, PKCE or not, and the hopper ships none: the runtime gives it
// (HOPPER_GITHUB_CLIENT_SECRET), and without it the device flow (device-flow.ts) is the way in.
import * as client from 'openid-client';
import type { Grant } from './device-flow.ts';
import type { HopperApp } from './hopper-app.ts';

/** The runtime variable that gives the hopper's app its client secret, which turns the browser redirect on. */
export const CLIENT_SECRET_VARIABLE = 'HOPPER_GITHUB_CLIENT_SECRET';

/** A loopback http GitHub (a test's fake) may skip https; nothing else may. */
const loopbackHttp = (u: string): boolean => {
  const x = new URL(u);
  return x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname);
};

export interface WebFlow {
  /** Where to send the browser; `state` comes back on the callback. `verifier` stays with the hopper. */
  start(state: string): Promise<{ url: string; verifier: string }>;
  /** The grant behind the callback URL; throws on a denial, a wrong state or a refused exchange. */
  finish(callback: URL, o: { verifier: string; state: string }): Promise<Grant>;
}

export function webFlow(app: HopperApp, clientSecret: string, redirectUri: string): WebFlow {
  const config = new client.Configuration(
    { issuer: app.url, authorization_endpoint: `${app.url}/login/oauth/authorize`, token_endpoint: `${app.url}/login/oauth/access_token` },
    app.clientId, undefined, client.ClientSecretPost(clientSecret),
  );
  if (loopbackHttp(app.url)) client.allowInsecureRequests(config);
  return {
    async start(state) {
      const verifier = client.randomPKCECodeVerifier();
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri, state,
        code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
      });
      return { url: url.href, verifier };
    },
    async finish(callback, o) {
      const denied = callback.searchParams.get('error');
      if (denied) throw new Error(denied === 'access_denied' ? 'the sign-in was denied at GitHub' : denied);
      const tokens = await client.authorizationCodeGrant(config, callback, { pkceCodeVerifier: o.verifier, expectedState: o.state }, { redirect_uri: redirectUri });
      const ends = typeof tokens.expires_in === 'number' ? new Date(Date.now() + tokens.expires_in * 1000) : undefined;
      // With the refresh token, which renews it (issue #358): GitHub answers its lifetime as refresh_token_expires_in.
      const refreshLife = tokens.refresh_token_expires_in;
      return {
        accessToken: tokens.access_token, grantedBy: 'web', ...(ends ? { expiresAt: ends } : {}),
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        ...(typeof refreshLife === 'number' ? { refreshTokenExpiresAt: new Date(Date.now() + refreshLife * 1000) } : {}),
      };
    },
  };
}
