// Deleting the access token of a connection the person drops (issue #597, design.md "One grant per
// connection"). GitHub's app token API (`DELETE /applications/{client_id}/token`, through
// @octokit/oauth-methods as the renewal is) deletes that one token; it needs the app's client secret. Never
// GitHub's credential revocation (`POST /credentials/revoke`): that is GitHub's leak report — it ends the
// whole authorization of the user at the app, the newest token too, and GitHub emails the owner a security
// notice. With no client secret nothing is sent, and the token expires by itself within 8 hours.
import { request as octokitRequest } from '@octokit/request';
import { deleteToken } from '@octokit/oauth-methods';
import type { HopperApp } from './hopper-app.ts';

/** Deletes this access token at GitHub: true once deleted, false when there is no client secret to send. Throws GitHub's refusal or a failed request. */
export type TokenDeletion = (accessToken: string) => Promise<boolean>;

/** How long a token deletion may hold up a disconnect. */
export const DELETE_TIMEOUT_MS = 10_000;

export function tokenDeletion(app: HopperApp, clientSecret: () => string | undefined): TokenDeletion {
  const base = octokitRequest.defaults({ baseUrl: app.apiUrl, headers: { 'user-agent': 'hopper', 'x-github-api-version': '2022-11-28' } });
  return async (accessToken) => {
    const secret = clientSecret();
    if (!secret) return false;
    const request = base.defaults({ request: { signal: AbortSignal.timeout(DELETE_TIMEOUT_MS) } });
    await deleteToken({ clientType: 'github-app', clientId: app.clientId, clientSecret: secret, token: accessToken, request });
    return true;
  };
}
