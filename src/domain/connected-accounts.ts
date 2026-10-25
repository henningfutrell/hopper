// A user's connected account (issue #214): the GitHub account their work comes through. Re-exported from types.ts.
import type { KeptAnswer } from './repo-checks.ts'; import type { NewRepositoryAsk, NewRepositoryPolicy } from './new-repositories.ts';

/** Where a user connects an account to work from: GitHub. */
export const CONNECTED_ACCOUNT_PROVIDERS = ['github'] as const;
export type ConnectedAccountProvider = (typeof CONNECTED_ACCOUNT_PROVIDERS)[number];

/**
 * A connected account's key (issue #1448): a user may connect more than one account at a provider, each with its own job
 * repositories. The first is keyed by its provider (`github`), so what was kept before stays as it was; each further one by
 * its provider and a number from 2 (`github-2`, `github-3`, …).
 */
export type ConnectedAccountKey = ConnectedAccountProvider | `${ConnectedAccountProvider}-${number}`;
const KEY = /^(github)(?:-([2-9]|[1-9]\d+))?$/;
/** Whether `s` is a connected account key. */
export const isConnectedAccountKey = (s: string): s is ConnectedAccountKey => KEY.test(s);
/** The provider a key's account is at. */
export const providerOfKey = (key: ConnectedAccountKey): ConnectedAccountProvider => KEY.exec(key)![1] as ConnectedAccountProvider;
/** Whether the key names a further account, not the first. */
export const furtherAccount = (key: ConnectedAccountKey): boolean => key !== providerOfKey(key);

/** How every connected account reaches its provider: the app the hopper ships (its GitHub App; the client id is public). */
export const CONNECTED_VIA = 'the hopper\'s app';

/**
 * GitHub: one installation of the hopper's app that the connected account can see — the account it is
 * installed on and the repositories it reaches there that this account can see. `all`: every repository
 * of that account; `selected`: only the chosen ones. `settingsUrl`: where to choose them on GitHub.
 * `permissions`: what the installation grants there, as GitHub says it (`issues: 'write'`, …; issue #352).
 * `avatarUrl`: the picture of the account it is installed on, which Sources shows by its repositories (issue #2774).
 */
export interface AppInstallation {
  account: string;
  avatarUrl?: string;
  repositorySelection: 'all' | 'selected';
  repositories: string[];
  settingsUrl?: string;
  permissions?: Record<string, string>;
  /**
   * The installation's **permission request** (issue #1378): the permissions the hopper's app asks for that it does not
   * grant yet, which GitHub asked its owner to accept; empty: accepted, nothing waits. Absent: not known (no app slug,
   * GitHub did not answer the app, or a read from before issue #1378).
   */
  permissionRequest?: Record<string, string>;
}

/**
 * A user's connected account at one provider, by its key (issue #1448), as GET /api/connected-accounts reports it: connected
 * (the account, when), not connected, expired, unreadable, waiting on the device code the user enters at
 * `verificationUri`, or failed. Facts only, never a token.
 */
export type ConnectedAccountStatus = {
  provider: ConnectedAccountProvider; key: ConnectedAccountKey; via: typeof CONNECTED_VIA;
  /**
   * GitHub: where to install the hopper's GitHub App, on the person's own account or an organization — it reaches only the
   * repositories it is installed on. In every state (issue #2759): installing it needs no connection. Absent for a personal
   * access token, a further account, or a hopper with no app.
   */
  installUrl?: string;
} & (
  | {
    state: 'connected'; account: string; connectedAt: string;
    /** The repositories this account's jobs may use, chosen in Sources (issue #321); empty: none, so no job. */
    jobRepositories: string[];
    /** GitHub: where the app's installations are seen and their repositories chosen. */
    configUrl?: string;
    /**
     * GitHub: the installations of the app this account can see, each with the repositories it reaches, as last read (issue
     * #1250: kept in the database, never read when shown); absent when they were never read, or no read worked yet. For a
     * personal access token (issue #1380, `grantedBy: 'token'`): the repositories the token reaches, one entry per owner.
     */
    installations?: AppInstallation[];
    /** GitHub: why the last read of where the app is installed failed; `installations` then holds the read before it, if any. */
    installationsError?: string;
    /** GitHub: when `installations` were read from GitHub (issue #1250); absent: not read yet. */
    installationsCheckedAt?: string;
    /** GitHub: a read of where the app is installed is under way (issue #1250). */
    installationsReading?: true;
    /** When the token now kept expires; absent: it does not. The hopper renews it an hour before (issue #441). */
    expiresAt?: string;
    /** Why the last renewal failed, while it is tried again (issue #441): GitHub not answering, or this hopper set up so it cannot renew. The sign-in goes on. */
    renewal?: string;
    /**
     * Why the token cannot be renewed at all (issue #518): GitHub gave it no refresh token. It ends at `expiresAt`, and
     * only connecting again (or signing in with GitHub again) gets one that renews.
     */
    unrenewable?: string;
    /** How GitHub granted it (issue #647): the browser's web flow or the device flow; `token`: a personal access token the person gave (issue #1380). */
    grantedBy?: 'device' | 'web' | 'token';
    /** How the person made it (issue #647): connected from Sources, or signed in with GitHub. */
    connectedBy?: 'sources' | 'sign-in';
    /** When its token was last renewed (issue #647); absent: not since it was connected. */
    renewedAt?: string;
    /** When the renewer renews it next (issue #647): an hour before its expiry, or the retry of a failed renewal. */
    nextRenewalAt?: string;
    /** The last renewal that failed (issue #647), kept after later renewals succeed: when, and why. */
    lastError?: { at: string; error: string };
    /**
     * A **held grant** (issue #647): a GitHub sign-in made while this connection was healthy, kept apart until the person
     * takes it (it replaces this connection) or drops it. A sign-in never quietly replaces a working connection.
     */
    held?: { account: string; at: string };
    /** The email the account was connected for (issue #1380, the source email match); each renewal checks it again. Absent: not checked. */
    matchEmail?: string;
    /** The account's new-repository policy and its open new-repository asks (issue #2795). */
    newRepositories?: { policy: NewRepositoryPolicy; asks: NewRepositoryAsk[] };
  }
  | { state: 'not-connected' }
  /** Its sign-in ended (issue #358): GitHub refused its refresh token (revoked, or the app's authorization removed), or it expired with nothing to renew it. Connect again. `error`: why. */
  | { state: 'expired'; account: string; connectedAt: string; error: string }
  /** Its tokens are sealed under a key the runtime does not give (issue #514): not ended — give the key back. `error`: what to do. */
  | { state: 'unreadable'; account: string; connectedAt: string; error: string }
  | { state: 'waiting'; userCode: string; verificationUri: string; expiresAt: string }
  | { state: 'failed'; error: string }
);

/**
 * Where the hopper's app is installed, as last read for a provider's connected `account` (issue #1250), kept in the
 * database, so Sources shows it and a restart reads nothing again. `at`: when the installations were read; `nextAt`: when
 * the schedule reads again — `FRESH_MS` after a read, a backoff that doubles with each failure in a row (`failures`), or
 * when GitHub's rate limit lets it. A failed read keeps the installations read before, with `error`. `etags`: the answers
 * of the read, by request, for the next read's conditional requests.
 */
export interface AppInstallationsRead {
  provider: ConnectedAccountProvider;
  account: string;
  at?: string;
  nextAt: string;
  failures: number;
  installations?: AppInstallation[];
  error?: string;
  etags: Record<string, KeptAnswer>;
}

/** The kept reads (tenant migration 66): one row per connected account, by its key (issue #1448: the first's is its provider). */
export interface AppInstallationsReadRepository {
  get(key: ConnectedAccountKey): AppInstallationsRead | undefined;
  /** `key`: the account's; absent: the read's provider, the first account's. */
  put(read: AppInstallationsRead, key?: ConnectedAccountKey): void;
  remove(key: ConnectedAccountKey): void;
}
