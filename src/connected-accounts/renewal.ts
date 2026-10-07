// Renewing a GitHub App user token (issue #358): GitHub trades the refresh token for a new access token and
// a new refresh token, once — through @octokit/oauth-methods, as the device flow is. The app's client secret
// goes with it when the runtime gives one (a web flow grant needs it); a device flow grant renews without.
import { request as octokitRequest } from '@octokit/request';
import { refreshToken } from '@octokit/oauth-methods';
import { grantOf, type Grant } from './device-flow.ts';
import type { HopperApp } from './hopper-app.ts';

/** The new pair for a refresh token; throws GitHub's refusal (an OAuth error, see `oauthError`) or a failed request. */
export type Renewal = (refresh: string) => Promise<Grant>;

export function renewal(app: HopperApp, clientSecret: () => string | undefined): Renewal {
  const request = octokitRequest.defaults({ baseUrl: app.apiUrl, headers: { 'user-agent': 'hopper' } });
  return async (refresh) => {
    // Undefined is left out of the request body: no secret is sent when the runtime gives none.
    const { authentication } = await refreshToken({ clientType: 'github-app', clientId: app.clientId, clientSecret: clientSecret() as string, refreshToken: refresh, request });
    return grantOf(authentication);
  };
}
