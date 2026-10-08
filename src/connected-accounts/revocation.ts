// Revoking a GitHub grant the hopper replaces or drops (issue #514, design.md "Keeping the connection").
// GitHub keeps at most ten tokens per user and app; making an eleventh revokes an older one — never used
// first, else the least recently used — whoever holds it. Each connect and each sign-in with GitHub is a new
// grant, so a grant left behind at a reconnect or a disconnect counts toward the ten until it expires,
// months later. GitHub's credential revocation (`POST /credentials/revoke`, through @octokit/request as
// everything else here) takes the access token and the refresh token, needs no authentication and no client
// secret — the hopper's app ships none — and GitHub tells the account's owner by email that they were
// revoked. Best effort: a refusal or a timeout throws, the caller logs it and goes on.
import { request as octokitRequest } from '@octokit/request';
import type { HopperApp } from './hopper-app.ts';

/** Revokes these tokens at GitHub; throws when GitHub did not accept the request. */
export type Revocation = (credentials: string[]) => Promise<void>;

/** How long a revocation may hold up a connect, a sign-in or a disconnect. */
export const REVOKE_TIMEOUT_MS = 10_000;

export function revocation(app: HopperApp): Revocation {
  const request = octokitRequest.defaults({ baseUrl: app.apiUrl, headers: { 'user-agent': 'hopper', 'x-github-api-version': '2022-11-28' } });
  return async (credentials) => {
    if (credentials.length === 0) return;
    await request('POST /credentials/revoke', { credentials, request: { signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS) } });
  };
}
