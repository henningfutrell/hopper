// A user's connected account (issue #214): the GitHub account their work comes through. Re-exported from types.ts.

/** Where a user connects an account to work from: GitHub. */
export const CONNECTED_ACCOUNT_PROVIDERS = ['github'] as const;
export type ConnectedAccountProvider = (typeof CONNECTED_ACCOUNT_PROVIDERS)[number];

/** How every connected account reaches its provider: the app the hopper ships (its GitHub App; the client id is public). */
export const CONNECTED_VIA = 'the hopper\'s app';

/**
 * GitHub: one installation of the hopper's app that the connected account can see — the account it is
 * installed on and the repositories it reaches there that this account can see. `all`: every repository
 * of that account; `selected`: only the chosen ones. `settingsUrl`: where to choose them on GitHub.
 */
export interface AppInstallation {
  account: string;
  repositorySelection: 'all' | 'selected';
  repositories: string[];
  settingsUrl?: string;
}

/**
 * A user's connected account at one provider, as GET /api/connected-accounts reports it: connected
 * (the account, when), not connected, expired, waiting on the device code the user enters at
 * `verificationUri`, or failed. Facts only, never a token.
 */
export type ConnectedAccountStatus = { provider: ConnectedAccountProvider; via: typeof CONNECTED_VIA } & (
  | {
    state: 'connected'; account: string; connectedAt: string;
    /** The repositories this account's jobs may use, chosen in Sources (issue #321); empty: none, so no job. */
    jobRepositories: string[];
    /** GitHub: where to install the hopper's GitHub App — it reaches only the repositories it is installed on. */
    installUrl?: string;
    /** GitHub: where the app's installations are seen and their repositories chosen. */
    configUrl?: string;
    /** GitHub: the installations of the app this account can see, each with the repositories it reaches; absent when GitHub could not be asked. */
    installations?: AppInstallation[];
    /** GitHub: why GitHub could not say where the app is installed (then `installations` is absent). */
    installationsError?: string;
  }
  | { state: 'not-connected' }
  /** Its sign-in ended (issue #358): GitHub refused its token and the renewal, or the token expired with nothing to renew it. Connect again. `error`: why. */
  | { state: 'expired'; account: string; connectedAt: string; error: string }
  | { state: 'waiting'; userCode: string; verificationUri: string; expiresAt: string }
  | { state: 'failed'; error: string }
);
