// The GitHub sources over one source logic, as the job-source plugins build them: `github-gh`
// (gh CLI, as the owner), `github-app` (the App adapter, as the bot), and a connected account's —
// `github-account` (issue #214), through the account the user signed in with or connected. Each
// pauses itself (JobSource.paused): gh while `enabled: auto` and a GitHub account is connected or the
// App's key variable is set, the app while its identity (appId, slug, key) is incomplete, an account's
// while it is not connected or its sign-in expired (issue #358) — an expired account pauses no gh source.
import { SourceError, type Clock, type ConnectedAccountTokens, type JobSource } from '../domain/ports.ts';
import { CONNECTED_VIA, type ConnectedAccountProvider } from '../domain/types.ts';
import { notConnected } from '../connected-accounts/service.ts';
import { createAccountGitHubApi } from './github/account/api.ts';
import { GitHubApiError } from './github/api.ts';
import { createGitHubAppApi, loadGitHubApp, type GitHubAppLoad } from './github/app/index.ts';
import type { GitHubApi } from './github/index.ts';
import { createGhCliApi, createGitHubSource } from './github/index.ts';
import { sourceConfig, type GitHubAccountOptions, type GitHubAppOptions, type GitHubGhOptions } from './config.ts';

export const GH_PAUSED = 'GitHub App configured';
export const GH_PAUSED_ACCOUNT = 'GitHub account connected';
export const APP_MISSING = 'no GitHub App configured';
/** A connected account's source lists only its job repositories (issue #321): none chosen, none listed. */
export const NO_REPOSITORIES = 'no repositories chosen for jobs: Sources → GitHub account → choose them';

/** Why the app cannot be used right now, or undefined when its identity is complete. */
export function appProblem(load: GitHubAppLoad): string | undefined {
  if (load.ok) return undefined;
  return load.reason === 'missing' ? APP_MISSING : load.reason;
}

export interface GitHubSourceDeps {
  /** The instance name: jobs and sync state are keyed by it. */
  name: string;
  clock: Clock;
  knownKeys: (keys: string[]) => Set<string>;
  rerunnable: (keys: string[]) => Set<string>;
  /** An environment variable of the daemon (the App key). */
  env(name: string): string | undefined;
  /** A double at the GitHubApi seam (tests). */
  api?: GitHubApi;
  /** Over the daemon's environment for the gh CLI: the user's gh config dir (issue #158). */
  userEnv?: Readonly<Record<string, string>>;
  /** The user's connected accounts (issue #214). */
  accounts?: ConnectedAccountTokens;
}

export function createGhSource(o: GitHubSourceDeps, options: GitHubGhOptions): JobSource {
  const keyEnv = options.appKeyEnv;
  return createGitHubSource({
    name: o.name, kind: 'github', mode: 'gh', config: sourceConfig(options), clock: o.clock, knownKeys: o.knownKeys, rerunnable: o.rerunnable,
    api: o.api ?? createGhCliApi({ bin: options.bin, ...(o.userEnv ? { userEnv: o.userEnv } : {}) }),
    paused: () => {
      if (options.enabled !== 'auto') return undefined;
      if (o.accounts?.account('github')) return GH_PAUSED_ACCOUNT;
      return keyEnv !== null && o.env(keyEnv)?.trim() ? GH_PAUSED : undefined;
    },
  });
}

/** Throws when `authors` holds the app's bot: its comments would be read as answers. */
export function createAppSource(o: GitHubSourceDeps, options: GitHubAppOptions): JobSource {
  const app = (): GitHubAppLoad => loadGitHubApp({
    ...(options.appId === undefined ? {} : { appId: options.appId }), ...(options.slug === undefined ? {} : { slug: options.slug }),
    privateKeyEnv: options.privateKeyEnv, privateKey: o.env(options.privateKeyEnv),
  });
  const bot = options.slug === undefined ? undefined : `${options.slug}[bot]`;
  if (bot !== undefined && options.authors.includes(bot)) {
    throw new Error(`authors must not contain the app bot ${bot}: the app's own writes must never count as the owner's`);
  }
  const real = o.api ? undefined : createGitHubAppApi({ app, keyEnv: options.privateKeyEnv, clock: o.clock, ...(options.apiUrl ? { baseUrl: options.apiUrl } : {}) });
  const api: GitHubApi = o.api ?? real!;
  return createGitHubSource({
    name: o.name, kind: 'github-app', mode: 'app', config: sourceConfig(options), clock: o.clock, knownKeys: o.knownKeys, rerunnable: o.rerunnable, api,
    paused: () => appProblem(app()),
    ...(real ? { appInfo: () => real.appStatus() } : {}),
  });
}

/**
 * A connected account's source (issue #214): the GitHub source logic over the account the user
 * connected, rebuilt when the account or its job repositories change — its login is the default author.
 * It lists only the job repositories (issue #321), read at each call, never a search over all the account
 * can reach. Paused, and saying why, while none is connected or no repository is chosen; a report then
 * waits for a connection (transient).
 */
export function createAccountSource(o: GitHubSourceDeps & { provider: ConnectedAccountProvider; accounts: ConnectedAccountTokens },
  options: GitHubAccountOptions): JobSource {
  const { provider, accounts } = o;
  const kind = `${provider}-account`;
  // The token at each call: a disconnect stops the next call, not only the next sync.
  const token = async (): Promise<string> => {
    try { return await accounts.token(provider); } catch (err) { throw new GitHubApiError((err as Error).message, false); }
  };
  const api = o.api ?? createAccountGitHubApi({ apiUrl: accounts.endpoints(provider).apiUrl, token, renew: (refused) => accounts.renew(provider, refused) });
  let built: { key: string; source: JobSource } | undefined;
  const current = (): JobSource | undefined => {
    const login = accounts.account(provider);
    if (!login) return undefined;
    const repos = accounts.jobRepositories(provider);
    const key = JSON.stringify([login, repos]);
    if (built?.key !== key) {
      const config = { ...sourceConfig(options), repos, authors: options.authors.length > 0 ? options.authors : [login] };
      built = {
        key,
        source: createGitHubSource({ name: o.name, kind, mode: 'account', whoami: login, config, api, clock: o.clock, knownKeys: o.knownKeys, rerunnable: o.rerunnable }),
      };
    }
    return built.source;
  };
  const unconnected = () => ({
    mode: 'account', repos: accounts.jobRepositories(provider), authors: options.authors, label: options.label,
    account: { service: provider, detail: { via: CONNECTED_VIA }, problem: accounts.ended(provider) ?? notConnected(provider) },
  });
  return {
    name: o.name,
    kind,
    paused: () => (!current() ? accounts.ended(provider) ?? notConnected(provider) : accounts.jobRepositories(provider).length === 0 ? NO_REPOSITORIES : undefined),
    describe: () => current()?.describe() ?? unconnected(),
    discover: () => current()?.discover() ?? Promise.resolve([]),
    check: (active) => current()?.check(active) ?? Promise.resolve([]),
    report(r) {
      const s = current();
      return s ? s.report(r) : Promise.reject(new SourceError(notConnected(provider), false));
    },
    notComplete(job) {
      const s = current();
      return s?.notComplete ? s.notComplete(job) : Promise.reject(new Error(notConnected(provider)));
    },
    closedAsComplete(job) {
      const s = current();
      return s?.closedAsComplete ? s.closedAsComplete(job) : Promise.reject(new Error(notConnected(provider)));
    },
    // Not connected, it cannot tell: no answer, and the jobs keep their last one (issue #362).
    closedItems(jobs, known) {
      const s = current();
      return s?.closedItems ? s.closedItems(jobs, known) : Promise.resolve(new Map());
    },
    // The job acts as the account's user, with the hopper's app marked on what it does: gh reads GH_TOKEN.
    // A job of an account no longer connected runs with none.
    async credentials(): Promise<Record<string, string>> {
      if (!accounts.account(provider)) return {};
      return { GH_TOKEN: await accounts.token(provider) };
    },
  };
}
