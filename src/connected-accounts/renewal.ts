// Renewing a GitHub App user token (issue #358): GitHub trades the refresh token for a new access token and
// a new refresh token, once — through @octokit/oauth-methods, as the device flow is. The app's client secret
// goes with it when the runtime gives one. GitHub takes a device flow grant's refresh without it, and a web
// flow grant's only with it (issue #441): a web flow grant with no secret to send is not sent at all, since
// GitHub would refuse it — it is blocked (`RenewalBlocked`) until the runtime gives the secret.
import { request as octokitRequest } from '@octokit/request';
import { refreshToken } from '@octokit/oauth-methods';
import { grantOf, type Grant } from './device-flow.ts';
import type { HopperApp } from './hopper-app.ts';
import { CLIENT_SECRET_VARIABLE } from './web-flow.ts';

/** The new pair for a refresh token; throws GitHub's refusal (an OAuth error, see `oauthError`), a failed request, or `RenewalBlocked`. */
export type Renewal = (refresh: string, grantedBy: Grant['grantedBy'] | undefined) => Promise<Grant>;

/** A renewal this hopper cannot make as it is set up (issue #441): never an end of the sign-in. */
export class RenewalBlocked extends Error {}

/** Why a web flow grant cannot be renewed here. */
export const NEEDS_CLIENT_SECRET = `renewing a GitHub sign-in made in the browser needs the app's client secret: set ${CLIENT_SECRET_VARIABLE}`;

export function renewal(app: HopperApp, clientSecret: () => string | undefined): Renewal {
  const request = octokitRequest.defaults({ baseUrl: app.apiUrl, headers: { 'user-agent': 'hopper' } });
  return async (refresh, grantedBy) => {
    const secret = clientSecret();
    if (grantedBy === 'web' && !secret) throw new RenewalBlocked(NEEDS_CLIENT_SECRET);
    // Undefined is left out of the request body: no secret is sent when the runtime gives none.
    const { authentication } = await refreshToken({ clientType: 'github-app', clientId: app.clientId, clientSecret: secret as string, refreshToken: refresh, request });
    return grantOf(authentication, grantedBy);
  };
}
