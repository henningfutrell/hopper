// A user's connected account (issue #214): the GitHub account their work comes through. Re-exported from types.ts.

/** Where a user connects an account to work from: GitHub. */
export const CONNECTED_ACCOUNT_PROVIDERS = ['github'] as const;
export type ConnectedAccountProvider = (typeof CONNECTED_ACCOUNT_PROVIDERS)[number];

/** How every connected account reaches its provider: the app the hopper ships (its GitHub App; the client id is public). */
export const CONNECTED_VIA = 'the hopper\'s app';

/**
 * A user's connected account at one provider, as GET /api/connected-accounts reports it: connected
 * (the account, when), not connected, waiting on the device code the user enters at
 * `verificationUri`, or failed. Facts only, never a token.
 */
export type ConnectedAccountStatus = { provider: ConnectedAccountProvider; via: typeof CONNECTED_VIA } & (
  | {
    state: 'connected'; account: string; connectedAt: string;
    /** GitHub: where to install the hopper's GitHub App — it reaches only the repositories it is installed on. */
    installUrl?: string;
    /** GitHub: the accounts the app is installed on that this account can see; absent when GitHub could not be asked. */
    installations?: string[];
  }
  | { state: 'not-connected' }
  | { state: 'waiting'; userCode: string; verificationUri: string; expiresAt: string }
  | { state: 'failed'; error: string }
);
