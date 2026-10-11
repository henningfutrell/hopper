// The GitHub JobSource: open issues labelled `hopper` and assigned to the user's connected account become
// jobs (issue #387) when their origin is trusted — written, labelled and assigned by the user's trusted actors — or a
// person approved their text; any other is a request card (issue #652, origin.ts);
// what happens to them goes back as labels only (no comment); closes and unlabels come
// back as cancel signals; unassigning the account cancels a waiting job and flags a started one. `knownKeys` (wired by the sync loop) tells discover which claimed issues already have
// a local job; without it every claimed issue is skipped, so nothing is ever re-run blind.
//
// One source, two identities (`mode`): `account` writes as the connected account's user and tells
// hopper comments by their marker; `app` writes as the app bot, scans only the repos the app is
// installed on, and tells hopper comments by the bot author (marker secondary). Neither searches.

import type { IntakeAction, IntakeChange, IntakeContext, IntakeOutcome, IntakeTrust, OutsideRepo } from '../../domain/intake.ts';
import { requestHash, type IntakeRequest } from '../../domain/intake-origin.ts';
import type { Clock, JobSource, SourceItem } from '../../domain/ports.ts';
import { CONNECTED_VIA, TERMINAL_STATUSES, type Account } from '../../domain/types.ts';
import type { GitHubApi, GitHubIssue } from './api.ts';
import type { GitHubSourceConfig } from '../config.ts';
import { checkJobs } from './check.ts';
import { closedAsComplete, notComplete, ownPullRequestOpen, partlyDone, unfinishedPullRequest, workState, type JobArtifacts } from './completion.ts';
import { followPullRequest } from './follow.ts';
import { crossReferencesOfJob } from './cross-references.ts';
import { unfollowedPullRequests } from './reconcile.ts';
import { partsOf, tickedParts } from './parts.ts';
import { sendBack } from './rework.ts';
import { contextBlock, contextComments, issueEnv, issuePrompt, promptWithText, untrustedBlock } from './context.ts';
import type { SourceMode } from './context.ts';
import { NOT_ASSIGNED, discoverIssues, isAssignedTo, labelReason, type Rejection } from './discover.ts';
import { intakeAct } from './intake-actions.ts';
import type { BotLogin } from './identity.ts';
import { priorityOf, readProjects } from './priority.ts';
import { openRequests, originsOf, REQUEST_REASON } from './origin.ts';
import { backburnerReader } from './backburner.ts';
import { recordIssueGraph, type IssueGraphRecorder } from './graph.ts';
import { reportToGitHub, takeBack, writeResolution } from './report.ts';

/** What the source reads of its config. */
export type GitHubSourceSettings = Pick<GitHubSourceConfig,
  'repos' | 'label' | 'hopperName' | 'priorityLabels' | 'defaultPriority' | 'executor' | 'model' | 'recentComments' | 'projects' | 'issueGraph' | 'graphRefreshMinutes'
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
  /** The user's trusted actors and approvals (issue #652): an issue not of a trusted origin is a request card. */
  trust: IntakeTrust;
  /** Whether a job on the repo may merge its own pull request (yolo mode, issue #579), read at each prompt; absent: never. */
  yoloMode?: (repo: string) => boolean;
  /** The artifacts a job made (issue #673): what makes an artifact-only issue done. Absent: none. */
  jobArtifacts?: JobArtifacts;
  /** The user's issue graph (issue #437): each listed issue's place is kept there. Absent: none is kept. */
  issueGraph?: IssueGraphRecorder;
}

/** How often the repos outside the source's scope are listed (issue #440): one listing, at most every 10 minutes. */
export const OUTSIDE_EVERY_MS = 10 * 60_000;
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
  let graphErrors: Record<string, string> = {};
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
  /** The request cards this process saw opened, as `<key> <hash>`: the events are read once per text. */
  const opened = new Set<string>();
  /** Since when and by whom each issue is on the backburner (issue #808), read once while the label stays. */
  const backburner = backburnerReader(api);

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

  /**
   * The issue's declared parts and how many are done (issue #729). Its merged parts cannot be read now: the ticked ones
   * only, read again next sync.
   */
  const issueParts = async (issue: GitHubIssue) => {
    try {
      return await partsOf(api, issue);
    } catch {
      return tickedParts(issue);
    }
  };

  const toItem = async (issue: GitHubIssue, known: Set<string>, rerun: Set<string>, p: ReturnType<typeof priorityOf>, bot: BotLogin, assignee: string | undefined): Promise<SourceItem> => {
    // An item whose job has not ended is offered only to follow its priority: its comments are not read (issue #662: its
    // text is compared without them).
    const unread = known.has(issue.url) && !rerun.has(issue.url) && config.recentComments !== 0;
    const comments = unread || config.recentComments === 0 ? [] : await api.listComments(issue.repo, issue.number);
    const seen = contextComments(comments, assignee, config.recentComments, bot);
    const untrusted = untrustedBlock(issue, seen, config.recentComments, mode);
    const parts = await issueParts(issue);
    const context = contextBlock(issue, p, o.yoloMode?.(issue.repo) ?? false, parts);
    return {
      text: { title: issue.title, body: issue.body, ...(unread ? {} : { comments: seen.map((c) => ({ author: c.author, at: c.createdAt, body: c.body })) }) },
      key: issue.url, url: issue.url, title: issue.title, body: issue.body,
      prompt: issuePrompt(untrusted, context), env: issueEnv(issue),
      author: issue.author, ...(assignee !== undefined ? { assignee } : {}), priority: p.priority, priorityReason: p.reason,
      labels: issue.labels, repo: issue.repo, number: issue.number, ...(parts ? { parts } : {}),
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

  /**
   * Approve a request card (issue #652): read the issue again; only when its title and body still hash as the person read
   * them, its text — with the assignee's comments the job would see — is the item's approved snapshot. False: it changed.
   */
  const approve = async (repo: string, key: string, request: IntakeRequest | undefined, a: IntakeAction): Promise<boolean> => {
    const issue = await api.getIssue(repo, numberOf(key));
    if (!request || request.hash !== a.hash || requestHash(issue) !== a.hash) return false;
    const item = await toItem(issue, new Set(), new Set(), priorityOf(issue, config, undefined), await botLogin(), o.assignee());
    o.trust.approve(o.name, key, { title: issue.title, body: issue.body, comments: item.text?.comments ?? [] }, request, a.acting);
    return true;
  };

  return {
    name: o.name,
    kind: o.kind ?? o.name,
    intake: () => outcomes.map((x) => ({ ...x })),
    intakeAction: (a) => intakeAct({ source: o.name, api, offered: outcomes, listedLabels, assignee: o.assignee(), intake: o.intake, approve }, a),
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
        ...(Object.keys(graphErrors).length ? { graphErrors } : {}),
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
      // An issue whose job has not ended keeps it, unless that job waits for its origin (the backfill); any other is judged
      // by its origin (issue #652).
      const judged = found.issues.filter((i) => !known.has(i.url) || rerun.has(i.url) || o.trust.originPending(i.url));
      const verdicts = await originsOf(api, o.trust, judged, config.label, assignee);
      const requests = new Map<string, IntakeRequest>();
      const items: SourceItem[] = [];
      for (const issue of found.issues) {
        const v = verdicts.get(issue.url);
        if (v && 'request' in v) { requests.set(issue.url, v.request); continue; }
        const item = await toItem(issue, known, rerun, priorityOf(issue, config, projects.views.get(issue.repo)), bot, assignee);
        items.push(v ? { ...item, origin: v.origin } : item);
      }
      outcomes = outcomes.map((x) => { const r = requests.get(x.key); return r ? { ...x, reason: REQUEST_REASON, action: 'approve' as const, group: 'request' as const, request: r } : x; });
      if (intake) openRequests(o.name, intake, requests, opened);
      outcomes = await backburner(outcomes);
      if (o.issueGraph && config.issueGraph) graphErrors = await recordIssueGraph({ api, graph: o.issueGraph, clock: o.clock, refreshMinutes: config.graphRefreshMinutes }, found.seen);
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
    async rework(job) {
      const back = await sendBack({ api, labelledRepos, ...(o.intake ? { holder: o.intake.holder } : {}) }, config.label, job, o.assignee());
      const bot = await botLogin();
      const projects = await readProjects(api, config, [back.issue]);
      const item = await toItem(back.issue, new Set(), new Set(), priorityOf(back.issue, config, projects.views.get(back.issue.repo)), bot, o.assignee());
      return { item, pullRequest: back.pullRequest, state: back.state };
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
    follow(job, act) {
      return followPullRequest({ api, labelledRepos, clock: o.clock, ...(o.intake ? { holder: o.intake.holder } : {}), ...(o.yoloMode ? { yoloMode: o.yoloMode } : {}) }, job, act);
    },
    unfollowedPullRequests: (jobs) => unfollowedPullRequests(api, jobs),
    crossReferences: (job) => crossReferencesOfJob(api, job),
    mergesOnReady: (repo) => o.yoloMode?.(repo) ?? false,
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
