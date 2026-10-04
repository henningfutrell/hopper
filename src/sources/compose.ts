// The two GitHub sources over one source logic, as the job-source plugins build them: `github-gh`
// (gh CLI, as the owner) and `github-app` (the App adapter, as the bot). Each pauses itself
// (JobSource.paused): gh while `enabled: auto` and the App's key variable is set, the app while its
// identity (appId, slug, key) is incomplete.
import type { Clock, JobSource } from '../domain/ports.ts';
import { createGitHubAppApi, loadGitHubApp, type GitHubAppLoad } from './github/app/index.ts';
import type { GitHubApi } from './github/index.ts';
import { createGhCliApi, createGitHubSource } from './github/index.ts';
import { sourceConfig, type GitHubAppOptions, type GitHubGhOptions } from './config.ts';

export const GH_PAUSED = 'GitHub App configured';
export const APP_MISSING = 'no GitHub App configured';

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
}

export function createGhSource(o: GitHubSourceDeps, options: GitHubGhOptions): JobSource {
  const keyEnv = options.appKeyEnv;
  return createGitHubSource({
    name: o.name, kind: 'github', mode: 'gh', config: sourceConfig(options), clock: o.clock, knownKeys: o.knownKeys, rerunnable: o.rerunnable,
    api: o.api ?? createGhCliApi({ bin: options.bin }),
    paused: () => (options.enabled === 'auto' && keyEnv !== null && o.env(keyEnv)?.trim() ? GH_PAUSED : undefined),
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
