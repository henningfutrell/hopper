// The GitHub JobSource: open issues labelled `hopper` and assigned to the user's connected account become
// jobs, whoever filed them (issue #387);
// what happens to them goes back as labels only (no comment); closes and unlabels come
// back as cancel signals; unassigning the account cancels a waiting job and flags a started one. `knownKeys` (wired by the sync loop) tells discover which claimed issues already have
// a local job; without it every claimed issue is skipped, so nothing is ever re-run blind.
//
// One source, two identities (`mode`): `account` writes as the connected account's user and tells
// hopper comments by their marker; `app` writes as the app bot, scans only the repos the app is
// installed on, and tells hopper comments by the bot author (marker secondary). Neither searches.

import type { IntakeAction, IntakeActionResult, IntakeChange, IntakeContext, IntakeOutcome, OutsideRepo } from '../../domain/intake.ts';
import type { Clock, JobSource, SourceItem } from '../../domain/ports.ts';
import { CONNECTED_VIA, TERMINAL_STATUSES, type Account } from '../../domain/types.ts';
import type { GitHubApi, GitHubIssue } from './api.ts';
import type { GitHubSourceConfig } from '../config.ts';
import { checkJobs } from './check.ts';
import { closedAsComplete, notComplete, ownPullRequestOpen, partlyDone, unfinishedPullRequest, workState, type JobArtifacts } from './completion.ts';
import { followPullRequest } from './follow.ts';
import { contextBlock, contextComments, issueEnv, issuePrompt, promptWithText, untrustedBlock } from './context.ts';
import type { SourceMode } from './context.ts';
import { NOT_ASSIGNED, discoverIssues, isAssignedTo, labelReason, type Rejection } from './discover.ts';
import { HOLDER_PREFIX, LABEL_CLAIMED } from './labels.ts';
import type { BotLogin } from './identity.ts';
import { priorityOf, readProjects } from './priority.ts';
import { reportToGitHub, takeBack, writeResolution } from './report.ts';

/** What the source reads of its config. */
export type GitHubSourceSettings = Pick<GitHubSourceConfig,
  'repos' | 'label' | 'hopperName' | 'priorityLabels' | 'defaultPriority' | 'executor' | 'model' | 'recentComments' | 'projects'
>;

/** The app's identity as the adapter knows it (its `appStatus()` fits), or undefined. */
export type GitHubAppInfo = { ok?: true; slug: string; htmlUrl: string; botLogin?: string } | { ok: false; reason: string };

export interface GitHubSourceOptions {
  name: string;
  /** Defaults to `name`. */
  kind?: string;
  mode: SourceMode;
  config: GitHubSourceSettings;
  api: GitHubApi;
  clock: Clock;
  /** The connected account's login. */
  whoami?: string;
  /**
   * The login an issue must be assigned to (issue #387): the user's connected GitHub account, asked at
   * each sync. Undefined: nothing to take (the source is paused for it).
   */
  assignee: () => string | undefined;
  /** Which of these source keys already have a local job. */
  knownKeys?: (keys: string[]) => Set<string>;
  /** Of the keys, those whose newest job may be re-run (`isRerunnable`); they are offered with comments for the new job. */
  rerunnable?: (keys: string[]) => Set<string>;
  /** Of the keys, those whose newest job was rejected (issue #387). */
  rejections?: (keys: string[]) => Map<string, Rejection>;
  /** A reason not to discover right now (see JobSource.paused). */
  paused?: () => string | undefined;
  /** App mode: slug/htmlUrl for the install link, or why the app is not usable. */
  appInfo?: () => GitHubAppInfo | undefined;
  /** Claim holders, the intake migration and intake events (issue #440); absent: claims carry no holder and nothing is migrated. */
  intake?: IntakeContext;
  /** Whether a job on the repo may merge its own pull request (yolo mode, issue #579), read at each prompt; absent: never. */
  yoloMode?: (repo: string) => boolean;
  /** The artifacts a job made (issue #673): what makes an artifact-only issue done. Absent: none. */
  jobArtifacts?: JobArtifacts;
}

/** How often the repos outside the source's scope are listed (issue #440): one listing, at most every 10 minutes. */
export const OUTSIDE_EVERY_MS = 10 * 60_000;
export const NOT_IN_SCOPE = 'not in this source\'s scope';
export const MIGRATION_RELEASED = 'released a claim with no holder recorded and no job in this hopper';
export const MIGRATION_UNASSIGNED = 'not assigned to you: assign it to you to take it';

const numberOf = (url: string): number => Number(url.slice(url.lastIndexOf('/') + 1));

export const CONFIG_URL = 'https://github.com/settings/installations';
export const CREATE_APP_HINT = 'create the app (scripts/create-github-app.sh), set its appId and slug on the github-app instance in Plugins and its key in GITHUB_APP_PRIVATE_KEY';

export function createGitHubSource(o: GitHubSourceOptions): JobSource {
  const { config, api } = o;
  const { mode } = o;
  const app = mode === 'app';
  const login = o.whoami;
  let repoErrors: Record<string, string> = {};
  let projectErrors: Record<string, string> = {};
  let checkErrors: Record<string, string> = {};
  let outcomes: IntakeOutcome[] = [];
  /** The labels of each issue the last discover listed, by URL: what a release removes. */
  let listedLabels = new Map<string, string[]>();
  let outsideRepos: OutsideRepo[] = [];
  let outsideError: string | undefined;
  let outsideAt: number | undefined;
  let lastDiscoverAt: string | undefined;
  let installedRepos: string[] = [];
  let nothingToScan = false;
  const labelledRepos = new Set<string>();

  /** App mode: the bot, once known (the app file, or the first sync). */
  let knownBot: string | undefined;
  const botLogin = async (): Promise<BotLogin> => {
    if (!app) return undefined;
    if (!api.botLogin) throw new Error('app mode needs the GitHub App adapter (no botLogin)');
    knownBot = await api.botLogin();
    return knownBot;
  };

  /** The installation is the allowlist; config `repos`, when set, narrows it further. */
  const appScope = async (): Promise<string[]> => {
    if (!api.listInstalledRepos) throw new Error('app mode needs the GitHub App adapter (no listInstalledRepos)');
    installedRepos = (await api.listInstalledRepos()).map((r) => r.repo);
    const wanted = new Set(config.repos.map((r) => r.toLowerCase()));
    return config.repos.length === 0 ? installedRepos : installedRepos.filter((r) => wanted.has(r.toLowerCase()));
  };

  const toItem = async (issue: GitHubIssue, known: Set<string>, rerun: Set<string>, p: ReturnType<typeof priorityOf>, bot: BotLogin, assignee: string | undefined): Promise<SourceItem> => {
    // An item whose job has not ended is offered only to follow its priority: its comments are not read (issue #662: its
    // text is compared without them).
    const unread = known.has(issue.url) && !rerun.has(issue.url) && config.recentComments !== 0;
    const comments = unread || config.recentComments === 0 ? [] : await api.listComments(issue.repo, issue.number);
    const seen = contextComments(comments, assignee, config.recentComments, bot);
    const untrusted = untrustedBlock(issue, seen, config.recentComments, mode);
    const context = contextBlock(issue, p, o.yoloMode?.(issue.repo) ?? false);
    return {
      text: { title: issue.title, body: issue.body, ...(unread ? {} : { comments: seen.map((c) => ({ author: c.author, at: c.createdAt, body: c.body })) }) },
      key: issue.url, url: issue.url, title: issue.title, body: issue.body,
      prompt: issuePrompt(untrusted, context), env: issueEnv(issue),
      author: issue.author, ...(assignee !== undefined ? { assignee } : {}), priority: p.priority, priorityReason: p.reason,
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
    return {
      mode: 'app',
      ...(ok ? { slug: ok.slug, htmlUrl: ok.htmlUrl, installUrl } : {}),
      configUrl: CONFIG_URL, installedRepos,
      ...(setup ? { setup } : {}),
      ...(reason !== undefined && reason !== 'missing' ? { appError: reason } : {}),
    };
  };

  /**
   * Who this source acts as on GitHub (glossary "Account"): the connected account's user, or the app's
   * bot and its installation repos.
   */
  const account = (paused: string | undefined, detail: Record<string, unknown>): Account => {
    const info = o.appInfo?.();
    const bot = knownBot ?? (info && info.ok !== false ? info.botLogin : undefined);
    const identity = app ? bot : login;
    const problem = paused ?? (typeof detail.appError === 'string' ? detail.appError : undefined);
    return {
      service: 'github', ...(identity ? { identity } : {}),
      detail: app ? { via: 'GitHub App', ...(typeof detail.slug === 'string' ? { app: detail.slug } : {}), installedRepos } : { via: CONNECTED_VIA },
      ...(problem ? { problem } : {}),
    };
  };

  /** The intake migration (issue #440): once, listing the claims it released and the issues not assigned to the user. */
  const migrate = (intake: IntakeContext, released: string[]) => {
    const changes: IntakeChange[] = [
      ...released.map((key) => ({ key, change: MIGRATION_RELEASED })),
      ...outcomes.filter((x) => x.reason === NOT_ASSIGNED).map((x) => ({ key: x.key, change: MIGRATION_UNASSIGNED })),
    ];
    intake.migrated({ at: o.clock.now().toISOString(), changes });
    intake.record('source.intake_migrated', { source: o.name, changes });
  };

  /**
   * Repos the account reaches outside the scope with open labelled issues for the user that would be taken there
   * (issue #440): only suggested in Sources, never added. A connected account only (the app has no user), at most
   * every OUTSIDE_EVERY_MS; with no scope at all, nothing is read.
   */
  const listOutside = async (repos: string[], assignee: string) => {
    if (!api.listAssignedIssues || repos.length === 0) return;
    const now = o.clock.now().getTime();
    if (outsideAt !== undefined && now - outsideAt < OUTSIDE_EVERY_MS) return;
    outsideAt = now;
    try {
      const inScope = new Set(repos.map((r) => r.toLowerCase()));
      const byRepo = new Map<string, string[]>();
      for (const i of await api.listAssignedIssues(config.label)) {
        if (inScope.has(i.repo.toLowerCase()) || !isAssignedTo(i, assignee) || labelReason(i, config.hopperName)) continue;
        byRepo.set(i.repo, [...(byRepo.get(i.repo) ?? []), i.url]);
      }
      outsideRepos = [...byRepo].map(([repo, items]) => ({ repo, items })).sort((a, b) => a.repo.localeCompare(b.repo));
      outsideError = undefined;
    } catch (err) {
      outsideError = (err as Error).message;
    }
  };

  /** Assign to me, or release a claim (issue #440): only on items the last discover offered it for. */
  const act = async (a: IntakeAction): Promise<IntakeActionResult> => {
    const offered = new Map(outcomes.map((x) => [x.key, x]));
    const assignee = o.assignee();
    const done: string[] = [];
    const failed: Record<string, string> = {};
    for (const key of [...new Set(a.keys)]) {
      const x = offered.get(key);
      if (!x?.repo) { failed[key] = NOT_IN_SCOPE; continue; }
      if (x.action !== a.kind) { failed[key] = `not offered: ${x.reason ?? 'taken'}`; continue; }
      try {
        if (a.kind === 'assign') {
          if (!assignee) throw new Error('no GitHub account connected');
          await api.addAssignees(x.repo, numberOf(key), [assignee]);
        } else {
          const holders = (listedLabels.get(key) ?? []).filter((l) => l.startsWith(HOLDER_PREFIX));
          await api.removeLabels(x.repo, numberOf(key), [LABEL_CLAIMED, ...holders]);
          o.intake?.record('source.claim_released', { source: o.name, key, by: 'user', reason: 'released in Sources' });
        }
        done.push(key);
      } catch (err) {
        failed[key] = (err as Error).message;
      }
    }
    if (a.kind === 'assign' && done.length > 0) o.intake?.record('source.issues_assigned', { source: o.name, keys: done, assignee });
    return { done, failed };
  };

  return {
    name: o.name,
    kind: o.kind ?? o.name,
    intake: () => outcomes.map((x) => ({ ...x })),
    intakeAction: act,
    ...(o.paused ? { paused: o.paused } : {}),
    describe() {
      const paused = o.paused?.();
      const detail = app ? appDetail() : { mode, ...(login ? { login } : {}) };
      return {
        ...detail,
        account: account(paused, detail),
        ...(paused ? { paused } : {}),
        repos: config.repos, ...(o.assignee() ? { assignee: o.assignee() } : {}), label: config.label, hopperName: config.hopperName, projectErrors,
        ...(o.intake?.migration() ? { intakeMigration: o.intake.migration() } : {}),
        ...(outsideRepos.length ? { outsideRepos } : {}),
        ...(outsideError ? { outsideError } : {}),
        ...(Object.keys(repoErrors).length ? { repoErrors } : {}),
        ...(Object.keys(checkErrors).length ? { checkErrors } : {}),
        ...(lastDiscoverAt ? { lastDiscoverAt } : {}),
      };
    },
    async discover() {
      const bot = await botLogin();
      const assignee = o.assignee();
      const repos = bot === undefined ? config.repos : await appScope();
      nothingToScan = app && repos.length === 0;
      if (nothingToScan || assignee === undefined) {
        repoErrors = {};
        outcomes = [];
        listedLabels = new Map();
        projectErrors = {};
        lastDiscoverAt = o.clock.now().toISOString();
        return [];
      }
      const intake = o.intake;
      const migrating = intake !== undefined && intake.migration() === undefined;
      const found = await discoverIssues(api, config, {
        repos, assignee, ...(o.knownKeys ? { knownKeys: o.knownKeys } : {}), ...(o.rejections ? { rejections: o.rejections } : {}),
        ...(intake ? { holder: intake.holder, othersKnown: intake.othersKnown, migrating } : {}),
      });
      repoErrors = found.repoErrors;
      outcomes = found.outcomes;
      listedLabels = found.listed;
      for (const r of found.released) intake?.record('source.claim_released', { source: o.name, key: r.key, by: r.by, reason: r.reason });
      if (intake && migrating && found.migrated) migrate(intake, found.released.filter((r) => r.by === 'migration').map((r) => r.key));
      await listOutside(repos, assignee);
      const projects = await readProjects(api, config, found.issues);
      projectErrors = projects.errors;
      const urls = found.issues.map((i) => i.url);
      const known = o.knownKeys && urls.length > 0 ? o.knownKeys(urls) : new Set<string>();
      const rerun = o.rerunnable && urls.length > 0 ? o.rerunnable(urls) : new Set<string>();
      const items: SourceItem[] = [];
      for (const issue of found.issues) items.push(await toItem(issue, known, rerun, priorityOf(issue, config, projects.views.get(issue.repo)), bot, assignee));
      lastDiscoverAt = o.clock.now().toISOString();
      return items;
    },
    async check(active) {
      const mine = active.filter((j) => j.source?.source === o.name && !TERMINAL_STATUSES.includes(j.status));
      if (mine.length === 0) return [];
      const r = await checkJobs(api, config, mine);
      checkErrors = r.errors;
      return r.signals;
    },
    report(r) {
      return reportToGitHub({ api, labelledRepos, ...(o.intake ? { holder: o.intake.holder } : {}) }, r);
    },
    async rerun(job) {
      const issue = await takeBack({ api, labelledRepos, ...(o.intake ? { holder: o.intake.holder } : {}) }, config.label, job, o.assignee());
      const bot = await botLogin();
      const projects = await readProjects(api, config, [issue]);
      return toItem(issue, new Set(), new Set(), priorityOf(issue, config, projects.views.get(issue.repo)), bot, o.assignee());
    },
    withText(item, text) {
      return { ...item, ...promptWithText(item, text, config.recentComments, mode) };
    },
    async editsSince(item, since) {
      if (!api.issueEdits || item.repo === undefined || item.number === undefined) return [];
      return (await api.issueEdits(item.repo, item.number)).filter((e) => e.at > since);
    },
    resolved(job, resolution) {
      return writeResolution({ api, labelledRepos, ...(o.intake ? { holder: o.intake.holder } : {}) }, job, resolution);
    },
    notComplete(job) {
      return notComplete(api, job, o.jobArtifacts);
    },
    partlyDone(job) {
      return partlyDone(api, job);
    },
    unfinishedPullRequest(job) {
      return unfinishedPullRequest(api, job);
    },
    follow(job) {
      return followPullRequest({ api, labelledRepos, ...(o.intake ? { holder: o.intake.holder } : {}), ...(o.yoloMode ? { yoloMode: o.yoloMode } : {}) }, job);
    },
    closedAsComplete(job) {
      return closedAsComplete(api, job);
    },
    workState(job) {
      return workState(api, job);
    },
    pullRequestOpen(job) {
      return ownPullRequestOpen(api, job);
    },
  };
}
