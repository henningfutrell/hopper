// The two GitHub sources over one source logic, as the job-source plugins build them: `github-gh`
// (gh CLI, as the owner) and `github-app` (the App adapter, as the bot). Each pauses itself
// (JobSource.paused): gh while `enabled: auto` and its `appFile` is readable, the app while its app
// file is not.
import { accessSync, constants } from 'node:fs';
import type { Clock, JobSource } from '../domain/ports.ts';
import { createGitHubAppApi, loadGitHubAppFile } from './github/app/index.ts';
import type { GitHubApi } from './github/index.ts';
import { createGhCliApi, createGitHubSource } from './github/index.ts';
import { expandHome, sourceConfig, type GitHubAppOptions, type GitHubGhOptions } from './config.ts';

export const GH_PAUSED = 'GitHub App configured';
export const APP_MISSING = 'no GitHub App configured';

/** Why the app file cannot be used right now, or undefined when it is readable. */
export function appFileProblem(file: string): string | undefined {
  try {
    accessSync(file, constants.R_OK);
    return undefined;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? APP_MISSING : `cannot read ${file}: ${(err as Error).message}`;
  }
}

export interface GitHubSourceDeps {
  /** The instance name: jobs and sync state are keyed by it. */
  name: string;
  clock: Clock;
  knownKeys: (keys: string[]) => Set<string>;
  rerunnable: (keys: string[]) => Set<string>;
  /** A double at the GitHubApi seam (tests). */
  api?: GitHubApi;
}

export function createGhSource(o: GitHubSourceDeps, options: GitHubGhOptions): JobSource {
  const appFile = options.appFile === null ? undefined : expandHome(options.appFile);
  return createGitHubSource({
    name: o.name, kind: 'github', mode: 'gh', config: sourceConfig(options), clock: o.clock, knownKeys: o.knownKeys, rerunnable: o.rerunnable,
    api: o.api ?? createGhCliApi({ bin: options.bin }),
    paused: () => (options.enabled === 'auto' && appFile !== undefined && appFileProblem(appFile) === undefined ? GH_PAUSED : undefined),
  });
}

/** Throws when `authors` holds the app's bot: its comments would be read as answers. */
export function createAppSource(o: GitHubSourceDeps, options: GitHubAppOptions): JobSource {
  const appFile = expandHome(options.appFile);
  const loaded = loadGitHubAppFile(appFile);
  if (loaded.ok && options.authors.includes(loaded.app.botLogin)) {
    throw new Error(`authors must not contain the app bot ${loaded.app.botLogin}: the app's own writes must never count as the owner's`);
  }
  const real = o.api ? undefined : createGitHubAppApi({ appFile, clock: o.clock, ...(options.apiUrl ? { baseUrl: options.apiUrl } : {}) });
  const api: GitHubApi = o.api ?? real!;
  return createGitHubSource({
    name: o.name, kind: 'github-app', mode: 'app', config: sourceConfig(options), clock: o.clock, knownKeys: o.knownKeys, rerunnable: o.rerunnable, api,
    paused: () => appFileProblem(appFile),
    ...(real ? { appInfo: () => real.appStatus() } : {}),
  });
}
