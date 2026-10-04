// sources.yaml → the GitHub sources that run, plus fixed statuses for the ones that do not.
// Two identities over one source logic: `github` (gh CLI, as the owner) and `github-app` (the App
// adapter, as the bot). Both are built unless set to false; each pauses itself (JobSource.paused):
// gh while `enabled: auto` and the app file is readable, the app while the app file is not.
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import type { Clock, JobSource } from '../domain/ports.ts';
import type { SourceStatus } from '../domain/types.ts';
import { createGitHubAppApi, loadGitHubAppFile } from './github/app/index.ts';
import type { GitHubApi } from './github/index.ts';
import { createGhCliApi, createGitHubSource, createJobTokenKeeper } from './github/index.ts';
import type { GitHubAppSourceConfig, GitHubSourceConfig } from './config.ts';
import { loadSourcesFile } from './config.ts';
import { idleStatus } from './index.ts';

export interface ComposeSourcesOptions {
  sourcesFile: string;
  ghBin: string;
  /** API base of the App adapter and of the jobs' hopper-comment (undefined → api.github.com). */
  githubApiUrl?: string;
  /** Job token files go to `<dataDir>/job-tokens`. */
  dataDir: string;
  /** Absolute path of scripts/hopper-comment (HOPPER_COMMENT_CMD). */
  commentCmd: string;
  clock: Clock;
  knownKeys: (keys: string[]) => Set<string>;
  rerunnable: (keys: string[]) => Set<string>;
  /** Doubles at the GitHubApi seam (tests). */
  github?: GitHubApi;
  githubApp?: GitHubApi;
}

export interface ComposedSources { sources: JobSource[]; fixed: SourceStatus[]; pollMs: Map<string, number>; throttleMs: Map<string, number> }

export const GH_PAUSED = 'GitHub App configured';
export const APP_MISSING = 'no GitHub App configured';

/** Why the app file cannot be used right now, or undefined when it is readable. */
function appFileProblem(file: string): string | undefined {
  try {
    accessSync(file, constants.R_OK);
    return undefined;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? APP_MISSING : `cannot read ${file}: ${(err as Error).message}`;
  }
}

/** The bot login when the app file loads, so `authors` can be refused before anything runs. */
function botConflict(app: GitHubAppSourceConfig): string | undefined {
  const r = loadGitHubAppFile(app.appFile);
  if (!r.ok || !app.authors.includes(r.app.botLogin)) return undefined;
  return `githubApp.authors must not contain the app bot ${r.app.botLogin}: its comments would be read as answers`;
}

export function composeSources(o: ComposeSourcesOptions): ComposedSources {
  const out: ComposedSources = { sources: [], fixed: [], pollMs: new Map(), throttleMs: new Map() };
  const file = loadSourcesFile(o.sourcesFile);
  const where = { path: o.sourcesFile };
  if ('error' in file) {
    console.error(`job-hopper: ${file.error} — no source runs from it`);
    out.fixed.push(idleStatus('github', 'github', 'error', { error: file.error, detail: where }));
    out.fixed.push(idleStatus('github-app', 'github-app', 'error', { error: file.error, detail: where }));
    return out;
  }
  const add = (source: JobSource, cfg: { pollSeconds: number; progressCommentSeconds: number }) => {
    out.sources.push(source);
    out.pollMs.set(source.name, cfg.pollSeconds * 1000);
    out.throttleMs.set(source.name, cfg.progressCommentSeconds * 1000);
  };
  const app = file.githubApp;
  const appLive = () => app.enabled && appFileProblem(app.appFile) === undefined;

  if (!file.github || file.github.enabled === false) {
    out.fixed.push(idleStatus('github', 'github', 'disabled', { detail: { ...where, mode: 'gh', ...(file.note ? { note: file.note } : {}) } }));
  } else {
    add(ghSource(o, file.github, appLive), file.github);
  }

  if (!app.enabled) {
    out.fixed.push(idleStatus('github-app', 'github-app', 'disabled', { detail: { ...where, mode: 'app' } }));
  } else {
    const conflict = botConflict(app);
    if (conflict) out.fixed.push(idleStatus('github-app', 'github-app', 'error', { error: conflict, detail: { ...where, mode: 'app' } }));
    else add(appSource(o, app), app);
  }
  return out;
}

function ghSource(o: ComposeSourcesOptions, gh: GitHubSourceConfig, appLive: () => boolean): JobSource {
  return createGitHubSource({
    name: 'github', kind: 'github', mode: 'gh', config: gh, clock: o.clock, knownKeys: o.knownKeys, rerunnable: o.rerunnable,
    api: o.github ?? createGhCliApi({ bin: o.ghBin }),
    paused: () => (gh.enabled === 'auto' && appLive() ? GH_PAUSED : undefined),
  });
}

function appSource(o: ComposeSourcesOptions, app: GitHubAppSourceConfig): JobSource {
  const real = o.githubApp ? undefined : createGitHubAppApi({ appFile: app.appFile, clock: o.clock, ...(o.githubApiUrl ? { baseUrl: o.githubApiUrl } : {}) });
  const api: GitHubApi = o.githubApp ?? real!;
  return createGitHubSource({
    name: 'github-app', kind: 'github-app', mode: 'app', config: app, clock: o.clock, knownKeys: o.knownKeys, rerunnable: o.rerunnable, api,
    paused: () => appFileProblem(app.appFile),
    tokens: createJobTokenKeeper({ dir: join(o.dataDir, 'job-tokens'), api, clock: o.clock }),
    commentCmd: o.commentCmd,
    ...(o.githubApiUrl ? { apiBase: o.githubApiUrl } : {}),
    ...(real ? { appInfo: () => real.appStatus() } : {}),
  });
}
