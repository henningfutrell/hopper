// GitHub's device flow (RFC 8628) for the hopper's GitHub App, with its client id and no secret (issue
// #214), through @octokit/oauth-methods: GitHub answers a pending code with 200 and an `error`, which a
// plain RFC client reads as a failure. No hand-rolled protocol.
//
// A GitHub App's user tokens expire after 8 hours unless the app opts out of token expiration, and come
// with a refresh token (6 months) that renews them (issue #358, renewal.ts): a token the device flow granted
// renews without the app's client secret. Both are kept.
import { request as octokitRequest } from '@octokit/request';
import { createDeviceCode, exchangeDeviceCode } from '@octokit/oauth-methods';
import type { HopperApp } from './hopper-app.ts';

/** What GitHub granted: the hopper's token for the account, and when it expires; with what renews it. */
export interface Grant {
  accessToken: string;
  /** Absent: the token does not expire (the app opted out). */
  expiresAt?: Date;
  /** Trades for a new pair once (issue #358); absent: the token does not expire. */
  refreshToken?: string;
  refreshTokenExpiresAt?: Date;
  /** Which flow granted it (issue #441): a web flow grant renews only with the app's client secret. A renewed grant keeps its first's; absent: one kept before #441. */
  grantedBy?: 'device' | 'web';
}

/** A grant from what @octokit/oauth-methods answers for a GitHub App's user token. */
export const grantOf = (a: { token: string; expiresAt?: string; refreshToken?: string; refreshTokenExpiresAt?: string }, grantedBy: Grant['grantedBy']): Grant => ({
  accessToken: a.token, ...(grantedBy ? { grantedBy } : {}),
  ...(a.expiresAt ? { expiresAt: new Date(a.expiresAt) } : {}),
  ...(a.refreshToken ? { refreshToken: a.refreshToken } : {}),
  ...(a.refreshTokenExpiresAt ? { refreshTokenExpiresAt: new Date(a.refreshTokenExpiresAt) } : {}),
});

/** A device code waiting for the person: shown until they approve it at `verificationUri`. */
export interface PendingGrant {
  userCode: string;
  verificationUri: string;
  expiresAt: Date;
  /** Polls until the person approves (the grant), denies or the code expires (throws), or `signal` aborts. */
  grant(signal: AbortSignal): Promise<Grant>;
}

export interface DeviceFlow {
  start(): Promise<PendingGrant>;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(signal.reason);
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

/** GitHub's OAuth error code (`authorization_pending`, `access_denied`, `bad_refresh_token`, …) of a refused request. */
export const oauthError = (err: unknown): string | undefined => {
  const e = err as { error?: unknown; response?: { data?: { error?: unknown } } };
  const code = e.error ?? e.response?.data?.error;
  return typeof code === 'string' ? code : undefined;
};

/** Why a device code ended without a grant, in the words the UI shows. */
export function deviceFlowFailure(err: unknown): string {
  switch (oauthError(err)) {
    case 'access_denied': return 'the code was denied';
    case 'expired_token': return 'the code expired before it was approved';
    case 'incorrect_client_credentials': case 'invalid_client': return 'GitHub does not know this app\'s client id';
    case 'unsupported_grant_type': case 'device_flow_disabled': return 'the app does not allow the device flow';
    default: return (err as Error).message;
  }
}

export function deviceFlow(app: HopperApp): DeviceFlow {
  // oauth-methods reaches the OAuth endpoints at the web origin of this API base.
  const request = octokitRequest.defaults({ baseUrl: app.apiUrl, headers: { 'user-agent': 'hopper' } });
  return {
    async start() {
      const { data } = await createDeviceCode({ clientType: 'github-app', clientId: app.clientId, request });
      let intervalMs = Math.max(data.interval, 1) * 1000;
      const expiresAt = new Date(Date.now() + data.expires_in * 1000);
      return {
        userCode: data.user_code, verificationUri: data.verification_uri, expiresAt,
        async grant(signal) {
          for (;;) {
            await sleep(intervalMs, signal);
            try {
              const { authentication } = await exchangeDeviceCode({ clientType: 'github-app', clientId: app.clientId, code: data.device_code, request });
              return grantOf(authentication, 'device');
            } catch (err) {
              const code = oauthError(err);
              if (code === 'authorization_pending') continue;
              if (code === 'slow_down') { intervalMs += 5000; continue; }
              throw err;
            }
          }
        },
      };
    },
  };
}
