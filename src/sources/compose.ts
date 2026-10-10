// The GitHub sources over one source logic, as the job-source plugins build them: `github-app` (the
// App adapter, as the bot), and a connected account's — `github-account` (issue #214), through the
// account the user signed in with or connected: the one way GitHub is read as the user (issue #359).
// Each pauses itself (JobSource.paused): the app while its identity (appId, slug, key) is incomplete,
// an account's while it is not connected or its sign-in expired (issue #358) — then it asks for a
// sign-in again; nothing falls back to another credential. Both take the issues assigned to the user's
// connected GitHub account (issue #387), so the app's pauses too while none is connected.
import { SourceError, type Clock, type ConnectedAccountTokens, type JobSource } from '../domain/ports.ts';
import { CONNECTED_VIA, type ConnectedAccountProvider } from '../domain/types.ts';
import { notConnected } from '../connected-accounts/service.ts';
import { createAccountGitHubApi } from './github/account/api.ts';
import { GitHubApiError } from './github/api.ts';
import type { Rejection } from './github/discover.ts';
import type { JobArtifacts } from './github/completion.ts';
import type { IntakeContext } from '../domain/intake.ts';
import { createGitHubAppApi, loadGitHubApp, type GitHubAppLoad } from './github/app/index.ts';
import type { GitHubApi } from './github/index.ts';
import { createGitHubSource } from './github/index.ts';
import { sourceConfig, type GitHubAccountOptions, type GitHubAppOptions } from './config.ts';

export const APP_MISSING = 'no GitHub App configured';
/** The app source takes issues assigned to the user's connected account (issue #387): none, nothing to take. */
export const NO_ASSIGNEE = 'no GitHub account connected: the app takes the issues assigned to it — Sources → Connect GitHub';
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
  /** Of the keys, those whose newest job was rejected: when, and the assignee it was taken for (issue #387). */
  rejections?: (keys: string[]) => Map<string, Rejection>;
  /** An environment variable of the daemon (the App key). */
  env(name: string): string | undefined;
  /** A double at the GitHubApi seam (tests). */
  api?: GitHubApi;
  /** The user's connected accounts (issue #214). */
  accounts?: ConnectedAccountTokens;
  /** Claim holders, the intake migration and intake events for this source (issue #440). */
  intake?: IntakeContext | undefined;
  /** The user's yolo mode for a repository (issue #579); absent: off. */
  yoloMode?: (repo: string) => boolean;
  /** The artifacts a job made (issue #673): what makes an artifact-only issue done. */
  jobArtifacts?: JobArtifacts;
}

/**
 * The app source: as the bot, over the repos it is installed on, taking the issues assigned to the user's
 * connected GitHub account — read at each call, so a connection made later applies at once.
 */
export function createAppSource(o: GitHubSourceDeps, options: GitHubAppOptions): JobSource {
  const app = (): GitHubAppLoad => loadGitHubApp({
    ...(options.appId === undefined ? {} : { appId: options.appId }), ...(options.slug === undefined ? {} : { slug: options.slug }),
    privateKeyEnv: options.privateKeyEnv, privateKey: o.env(options.privateKeyEnv),
  });
  const assignee = () => o.accounts?.account('github');
  const real = o.api ? undefined : createGitHubAppApi({ app, keyEnv: options.privateKeyEnv, clock: o.clock, ...(options.apiUrl ? { baseUrl: options.apiUrl } : {}) });
  const api: GitHubApi = o.api ?? real!;
  return createGitHubSource({
    name: o.name, kind: 'github-app', mode: 'app', config: sourceConfig(options), clock: o.clock, knownKeys: o.knownKeys, rerunnable: o.rerunnable,
    ...(o.rejections ? { rejections: o.rejections } : {}), ...(o.intake ? { intake: o.intake } : {}), ...(o.yoloMode ? { yoloMode: o.yoloMode } : {}), ...(o.jobArtifacts ? { jobArtifacts: o.jobArtifacts } : {}), api, assignee,
    paused: () => appProblem(app()) ?? (assignee() ? undefined : NO_ASSIGNEE),
    ...(real ? { appInfo: () => real.appStatus() } : {}),
  });
}

/**
 * A connected account's source (issue #214): the GitHub source logic over the account the user
 * connected, rebuilt when the account or its job repositories change — it takes the issues assigned to that login.
 * It lists only the job repositories (issue #321), read at each call, never a search over all the account
 * can reach. Paused, and saying why, while none is connected, its token expired (sign in again), or no
 * repository is chosen; a report then waits for a connection (transient).
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
      const config = { ...sourceConfig(options), repos };
      built = {
        key,
        source: createGitHubSource({
          name: o.name, kind, mode: 'account', whoami: login, assignee: () => login, config, api, clock: o.clock,
          knownKeys: o.knownKeys, rerunnable: o.rerunnable, ...(o.rejections ? { rejections: o.rejections } : {}),
          ...(o.intake ? { intake: o.intake } : {}), ...(o.yoloMode ? { yoloMode: o.yoloMode } : {}), ...(o.jobArtifacts ? { jobArtifacts: o.jobArtifacts } : {}),
        }),
      };
    }
    return built.source;
  };
  // `expired`: the sign-in ended (issue #441), so the UI asks to connect again on every screen. Not while its
  // tokens cannot be opened (issue #514): that asks for the key, never a new grant.
  // Why nothing goes through the account: its sign-in ended (issue #518: never "not connected" then), or none is.
  const why = () => accounts.ended(provider) ?? notConnected(provider);
  const unconnected = () => ({
    mode: 'account', repos: accounts.jobRepositories(provider), label: options.label,
    account: { service: provider, detail: { via: CONNECTED_VIA }, problem: why() },
    ...(accounts.expired(provider) ? { expired: true } : {}),
  });
  return {
    name: o.name,
    kind,
    paused: () => (!current() ? why() : accounts.jobRepositories(provider).length === 0 ? NO_REPOSITORIES : undefined),
    describe: () => current()?.describe() ?? unconnected(),
    discover: () => current()?.discover() ?? Promise.resolve([]),
    check: (active) => current()?.check(active) ?? Promise.resolve([]),
    report(r) {
      const s = current();
      return s ? s.report(r) : Promise.reject(new SourceError(why(), false));
    },
    notComplete(job) {
      const s = current();
      return s?.notComplete ? s.notComplete(job) : Promise.reject(new Error(why()));
    },
    closedAsComplete(job) {
      const s = current();
      return s?.closedAsComplete ? s.closedAsComplete(job) : Promise.reject(new Error(why()));
    },
    workState(job) {
      const s = current();
      return s?.workState ? s.workState(job) : Promise.reject(new Error(why()));
    },
    partlyDone(job) {
      const s = current();
      return s?.partlyDone ? s.partlyDone(job) : Promise.reject(new Error(why()));
    },
    unfinishedPullRequest(job) {
      const s = current();
      return s?.unfinishedPullRequest ? s.unfinishedPullRequest(job) : Promise.reject(new Error(why()));
    },
    follow(job) {
      const s = current();
      return s?.follow ? s.follow(job) : Promise.reject(new SourceError(why(), false));
    },
    rerun(job) {
      const s = current();
      return s?.rerun ? s.rerun(job) : Promise.reject(new SourceError(why(), false));
    },
    withText(item, text) {
      const s = current();
      if (!s?.withText) throw new SourceError(why(), false);
      return s.withText(item, text);
    },
    editsSince(item, since) {
      const s = current();
      return s?.editsSince ? s.editsSince(item, since) : Promise.resolve([]);
    },
    resolved(job, resolution) {
      const s = current();
      return s?.resolved ? s.resolved(job, resolution) : Promise.reject(new SourceError(why(), false));
    },
    intake: () => current()?.intake?.() ?? [],
    intakeAction(action) {
      const s = current();
      return s?.intakeAction ? s.intakeAction(action) : Promise.reject(new SourceError(why(), false));
    },
  };
}
