// Deleting a GitHub grant the hopper replaces or drops (issue #597, issue #514, design.md "Keeping the
// connection"). GitHub keeps at most ten tokens per user and app; making an eleventh revokes an older one —
// never used first, else the least recently used — whoever holds it. Each connect and each sign-in with
// GitHub is a new grant, so a grant left behind at a reconnect or a disconnect counts toward the ten until
// it expires, months later. The hopper deletes the old access token (`DELETE
// /applications/{client_id}/token`, through @octokit/request as everything else here), and only when the
// runtime gives the app's client secret — needed for the endpoint — and never revokes the refresh token: that
// is not routine cleanup, it is for a confirmed leak. The delete calls GitHub's email a security warning, so
// it is not sent during a sign-in, connect or replace: the token goes away only when its holder does not use
// it. Best effort: a refusal or a timeout throws, the caller logs it and goes on.
import { request as octokitRequest } from '@octokit/request';
import type { HopperApp } from './hopper-app.ts';

/** Deletes the old access token at GitHub when the runtime gives the client secret; throws when GitHub did not accept the request. */
export type TokenDeletion = (accessToken: string) => Promise<void>;

/** How long a deletion may hold up a connect, a sign-in or a disconnect. */
export const DELETE_TIMEOUT_MS = 10_000;

export function tokenDeletion(app: HopperApp, clientSecret: string | undefined): TokenDeletion {
  const request = octokitRequest.defaults({ baseUrl: app.apiUrl, headers: { 'user-agent': 'hopper', 'x-github-api-version': '2022-11-28' } });
  return async (accessToken) => {
    if (!clientSecret) return;
    await request('DELETE /applications/{client_id}/token', {
      client_id: app.clientId,
      access_token: accessToken,
      headers: { authorization: `basic ${Buffer.from(`${app.clientId}:${clientSecret}`).toString('base64')}` },
      request: { signal: AbortSignal.timeout(DELETE_TIMEOUT_MS) },
    });
  };
}
