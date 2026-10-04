// The GitHub JobSource: open issues labelled `hopper` by allowlisted authors become jobs;
// what happens to them goes back as comments and labels; replies and closes come back as
// signals. `knownKeys` (wired by the sync loop) tells discover which claimed issues already have
// a local job; without it every claimed issue is skipped, so nothing is ever re-run blind.
//
// One source, two identities (`mode`): `gh` posts as the owner and tells hopper comments by their
// marker; `app` posts as the app bot, scans only the repos the app is installed on (never a
// search), tells hopper comments by the bot author (marker secondary), and gives each job a
// token file to comment as the app.

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Clock, JobSource, SourceItem } from '../../domain/ports.ts';
import { TERMINAL_STATUSES } from '../../domain/types.ts';
import type { GitHubApi, GitHubIssue } from './api.ts';
import type { GitHubSourceConfig } from '../config.ts';
import { checkJobs } from './check.ts';
import { contextBlock, contextComments, issueEnv, issuePrompt } from './context.ts';
import type { SourceMode } from './context.ts';
import { discoverIssues } from './discover.ts';
import type { DiscoverScope } from './discover.ts';
import type { BotLogin } from './identity.ts';
import { priorityOf, readProjects } from './priority.ts';
import { reportToGitHub } from './report.ts';
import type { JobTokenKeeper } from './tokens.ts';

/** What the source reads of its config: the `github:` keys, or `githubApp:` (no owners). */
export type GitHubSourceSettings = Pick<GitHubSourceConfig,
  'repos' | 'authors' | 'label' | 'priorityLabels' | 'defaultPriority' | 'repoPaths' | 'defaultCwd' | 'executor' | 'model' | 'recentComments' | 'projects'
> & { owners?: string[]; enabled?: boolean | 'auto' };

/** The app's identity as the adapter knows it (its `appStatus()` fits), or undefined. */
export type GitHubAppInfo = { ok?: true; slug: string; htmlUrl: string } | { ok: false; reason: string };

export interface GitHubSourceOptions {
  name: string;
  /** Defaults to `name` (`github` / `github-app`). */
  kind?: string;
  /** Defaults to `gh`. */
  mode?: SourceMode;
  config: GitHubSourceSettings;
  api: GitHubApi;
  clock: Clock;
  /** The gh user, when already known (skips `whoami`). */
  whoami?: string;
  /** Which of these source keys already have a local job. */
  knownKeys?: (keys: string[]) => Set<string>;
  /** Of the keys, those whose newest job may be re-run (`isRerunnable`); they are offered with comments for the new job. */
  rerunnable?: (keys: string[]) => Set<string>;
  /** A reason not to discover right now (see JobSource.paused). */
  paused?: () => string | undefined;
  /** App mode: the per-job token keeper. */
  tokens?: JobTokenKeeper;
  /** App mode: the job's comment helper (HOPPER_COMMENT_CMD). */
  commentCmd?: string;
  /** App mode: the API base the comment helper talks to (HOPPER_GITHUB_API). */
  apiBase?: string;
  /** App mode: slug/htmlUrl for the install link, or why the app is not usable. */
  appInfo?: () => GitHubAppInfo | undefined;
}

export const CONFIG_URL = 'https://github.com/settings/installations';
export const CREATE_APP_HINT = 'run bash ~/.local/lib/job-hopper/scripts/create-github-app.sh';
const DEFAULT_COMMENT_CMD = join(homedir(), '.local/lib/job-hopper/scripts/hopper-comment');
const DEFAULT_API_BASE = 'https://api.github.com';

export function createGitHubSource(o: GitHubSourceOptions): JobSource {
  const { config, api } = o;
  const mode: SourceMode = o.mode ?? 'gh';
  const app = mode === 'app';
  let login = o.whoami;
  let owners = config.owners ?? [];
  let repoErrors: Record<string, string> = {};
  let projectErrors: Record<string, string> = {};
  let checkErrors: Record<string, string> = {};
  let skippedClaimedWithoutJob: string[] = [];
  let lastDiscoverAt: string | undefined;
  let installedRepos: string[] = [];
  let nothingToScan = false;
  const labelledRepos = new Set<string>();

  const botLogin = async (): Promise<BotLogin> => {
    if (!app) return undefined;
    if (!api.botLogin) throw new Error('app mode needs the GitHub App adapter (no botLogin)');
    return api.botLogin();
  };

  const ghScope = async (): Promise<DiscoverScope> => {
    if (owners.length === 0 && config.repos.length === 0) {
      login ??= await api.whoami();
      owners = [login];
    }
    return { repos: config.repos, owners };
  };

  /** The installation is the allowlist; config `repos`, when set, narrows it further. */
  const appScope = async (bot: string): Promise<DiscoverScope> => {
    if (config.authors.includes(bot)) throw new Error(`authors must not contain the app bot ${bot}: its comments would be read as answers`);
    if (!api.listInstalledRepos) throw new Error('app mode needs the GitHub App adapter (no listInstalledRepos)');
    installedRepos = (await api.listInstalledRepos()).map((r) => r.repo);
    const wanted = new Set(config.repos.map((r) => r.toLowerCase()));
    const repos = config.repos.length === 0 ? installedRepos : installedRepos.filter((r) => wanted.has(r.toLowerCase()));
    return { repos, owners: [] };
  };

  const appEnv = (issueUrl: string): Record<string, string> => ({
    ...(o.tokens ? { HOPPER_TOKEN_FILE: o.tokens.pathFor(issueUrl) } : {}),
    HOPPER_COMMENT_CMD: o.commentCmd ?? DEFAULT_COMMENT_CMD,
    HOPPER_GITHUB_API: o.apiBase ?? DEFAULT_API_BASE,
  });

  const toItem = async (issue: GitHubIssue, known: Set<string>, rerun: Set<string>, p: ReturnType<typeof priorityOf>, bot: BotLogin): Promise<SourceItem> => {
    const comments = (known.has(issue.url) && !rerun.has(issue.url)) || config.recentComments === 0 ? [] : await api.listComments(issue.repo, issue.number);
    const context = contextBlock(issue, p, contextComments(comments, config.authors, config.recentComments, bot), config.recentComments, mode);
    return {
      key: issue.url, url: issue.url, title: issue.title, body: issue.body,
      prompt: issuePrompt(issue, context), env: issueEnv(issue, app ? appEnv(issue.url) : {}),
      author: issue.author, priority: p.priority, priorityReason: p.reason,
      cwd: config.repoPaths[issue.repo] ?? config.defaultCwd,
      labels: issue.labels, repo: issue.repo, number: issue.number,
      executor: config.executor,
      ...(config.model ? { model: config.model } : {}),
      ...(issue.body.trim() === '' ? { invalid: 'empty issue body' } : {}),
    };
  };

  const appDetail = (): Record<string, unknown> => {
    const info = o.appInfo?.();
    const ok = info !== undefined && info.ok !== false ? info : undefined;
    const reason = info?.ok === false ? info.reason : undefined;
    const installUrl = ok ? `${ok.htmlUrl}/installations/new` : undefined;
    const setup = reason === 'missing' ? CREATE_APP_HINT
      : nothingToScan ? `install the app: ${installUrl ?? CONFIG_URL}` : undefined;
    const tokenErrors = o.tokens?.errors() ?? {};
    return {
      mode: 'app',
      ...(ok ? { slug: ok.slug, htmlUrl: ok.htmlUrl, installUrl } : {}),
      configUrl: CONFIG_URL, installedRepos,
      ...(setup ? { setup } : {}),
      ...(reason !== undefined && reason !== 'missing' ? { appError: reason } : {}),
      ...(Object.keys(tokenErrors).length ? { tokenErrors } : {}),
    };
  };

  return {
    name: o.name,
    kind: o.kind ?? o.name,
    ...(o.paused ? { paused: o.paused } : {}),
    describe() {
      const paused = o.paused?.();
      return {
        ...(app ? appDetail() : { mode: 'gh', enabledSetting: String(config.enabled ?? true), owners }),
        ...(paused ? { paused } : {}),
        repos: config.repos, authors: config.authors, label: config.label, projectErrors,
        ...(skippedClaimedWithoutJob.length ? { skippedClaimedWithoutJob } : {}),
        ...(Object.keys(repoErrors).length ? { repoErrors } : {}),
        ...(Object.keys(checkErrors).length ? { checkErrors } : {}),
        ...(lastDiscoverAt ? { lastDiscoverAt } : {}),
      };
    },
    async discover() {
      const bot = await botLogin();
      const scope = bot === undefined ? await ghScope() : await appScope(bot);
      nothingToScan = app && scope.repos.length === 0;
      if (nothingToScan) { // never a search in app mode (B7)
        repoErrors = {};
        skippedClaimedWithoutJob = [];
        projectErrors = {};
        lastDiscoverAt = o.clock.now().toISOString();
        return [];
      }
      const found = await discoverIssues(api, config, scope, o.knownKeys);
      repoErrors = found.repoErrors;
      skippedClaimedWithoutJob = found.skippedClaimedWithoutJob;
      const projects = await readProjects(api, config, found.issues);
      projectErrors = projects.errors;
      const urls = found.issues.map((i) => i.url);
      const known = o.knownKeys && urls.length > 0 ? o.knownKeys(urls) : new Set<string>();
      const rerun = o.rerunnable && urls.length > 0 ? o.rerunnable(urls) : new Set<string>();
      const items: SourceItem[] = [];
      for (const issue of found.issues) items.push(await toItem(issue, known, rerun, priorityOf(issue, config, projects.views.get(issue.repo)), bot));
      lastDiscoverAt = o.clock.now().toISOString();
      return items;
    },
    async check(active) {
      const mine = active.filter((j) => j.source?.source === o.name && !TERMINAL_STATUSES.includes(j.status));
      await o.tokens?.refresh(mine); // never throws; also sweeps files of jobs no longer active
      if (mine.length === 0) return [];
      const r = await checkJobs(api, config, mine, await botLogin());
      checkErrors = r.errors;
      return r.signals;
    },
    report(r) {
      return reportToGitHub({ api, labelledRepos, botLogin, ...(o.tokens ? { tokens: o.tokens } : {}) }, r);
    },
  };
}
