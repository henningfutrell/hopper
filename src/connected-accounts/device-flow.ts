// GitHub's device flow (RFC 8628) for the hopper's GitHub App, with its client id and no secret (issue
// #214), through @octokit/oauth-methods: GitHub answers a pending code with 200 and an `error`, which a
// plain RFC client reads as a failure. No hand-rolled protocol.
//
// A GitHub App's user tokens expire after 8 hours unless the app opts out of token expiration; GitHub
// renews one only with the app's client secret, which the hopper never has. So the hopper's GitHub App
// opts out (docs/sign-in.md), and a token that does expire asks the person to sign in again.
import { request as octokitRequest } from '@octokit/request';
import { createDeviceCode, exchangeDeviceCode } from '@octokit/oauth-methods';
import type { HopperApp } from './hopper-app.ts';

/** What GitHub granted: the hopper's token for the account, and when it expires. */
export interface Grant {
  accessToken: string;
  /** Absent: the token does not expire (the app opted out). */
  expiresAt?: Date;
}

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

/** GitHub's OAuth error code (`authorization_pending`, `access_denied`, …) of a refused request. */
const oauthError = (err: unknown): string | undefined => {
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
              const ends = 'expiresAt' in authentication && authentication.expiresAt ? new Date(authentication.expiresAt) : undefined;
              return { accessToken: authentication.token, ...(ends ? { expiresAt: ends } : {}) };
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
