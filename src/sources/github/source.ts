// The GitHub JobSource: open issues labelled `hopper` and assigned to the user's connected account become
// jobs (issue #387) when their origin is trusted — written, labelled and assigned by the user's trusted actors — or a
// person approved their text; any other is a request card (issue #652, origin.ts; a reopened issue too, issue #1126);
// what happens to them goes back as labels only (no comment); closes and unlabels come
// back as cancel signals; unassigning the account cancels a waiting job and flags a started one. `knownKeys` (wired by the sync loop) tells discover which claimed issues already have
// a local job; without it every claimed issue is skipped, so nothing is ever re-run blind.
//
// One source, two identities (`mode`): `account` writes as the connected account's user and tells
// hopper comments by their marker; `app` writes as the app bot, scans only the repos the app is
// installed on, and tells hopper comments by the bot author (marker secondary). Neither searches.
//
// Intake reads the listing cache (issue #985, `listing.ts`): the job repositories are listed again every intake sync
// interval, at once when a person asked for the sync, or at the next sync after a GitHub delivery said the repository
// changed (issue #1079, `repoChanged`). A discover and a check read a job's issue from what was kept
// while its listing shows no change (`listed-reads.ts`); every other read — before a write — goes to GitHub.
// Beside intake, a connected account's source reads the user's **tagged items** (issue #1141, `tagged.ts`).

import type { IntakeChange, IntakeContext, IntakeOutcome, IntakeTrust } from '../../domain/intake.ts';
import type { Clock, JobSource, SourceItem } from '../../domain/ports.ts';
import type { GitHubListingRepository } from '../../domain/github-listing.ts';
import { DEFAULT_RATE_LIMITER } from '../../domain/github-rate-limit.ts';
import { createIntakeListing, memoryListings } from './listing.ts';
import { listedReads } from './listed-reads.ts';
import { CONNECTED_VIA, DEFAULT_CHANGE_RULE, mergesOnReady, TERMINAL_STATUSES, type Account, type ChangeRule } from '../../domain/types.ts';
import type { GitHubApi, GitHubIssue } from './api.ts';
import type { GitHubSourceConfig } from '../config.ts';
import { checkJobs } from './check.ts';
import { issueState, notComplete, ownPullRequestChecks, ownPullRequestOpen, partlyDone, unfinishedPullRequest, workState, type JobArtifacts } from './completion.ts';
import { rerunChecks } from './rerun-checks.ts';
import { followPullRequest, housekeepStrays, tendStartedOn, type FollowContext } from './follow.ts';
import { crossReferencesOfJob } from './cross-references.ts';
import { unfollowedPullRequests } from './reconcile.ts';
import { pullRequestCensus } from './census.ts';
import { followedBatch } from './followed-batch.ts';
import { partsOf, tickedParts } from './parts.ts';
import { sendBack } from './rework.ts';
import { gitHubThread } from './thread.ts';
import { contextBlock, contextComments, issueEnv, issuePrompt, promptWithText, untrustedBlock, type SourceMode } from './context.ts';
import { NOT_ASSIGNED, discoverIssues, type Rejection } from './discover.ts';
import { intakeAct } from './intake-actions.ts';
import { createApprovals } from './approvals.ts';
import { createWriteBehind } from './write-behind.ts';
import { outsideReader } from './outside.ts';
import type { BotLogin } from './identity.ts';
import { priorityOf, readProjects } from './priority.ts';
import { awaitingBatch, closePromoted, openRequests, originsOf, reopenedRequests, requestOutcome, withdrawRequests } from './origin.ts';
import { backburnerReader } from './backburner.ts'; import { taggedReader } from './tagged.ts';
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
  /**
   * Whether a job on the repo may merge its own pull request (yolo mode, issue #579), read at each prompt; absent: never.
   * And a repository's landing branch, from its landing batch settings (issue #1143); absent or undefined: no pull request is moved.
   * And the change rule of a repository (issue #1076): a followed pull request's kind and its merge gate. Absent: the built-in rule.
   */
  yoloMode?: (repo: string) => boolean; landingBranch?: (repo: string) => string | undefined; changeRule?: (repo: string) => ChangeRule;
  /** The artifacts a job made (issue #673): what makes an artifact-only issue done. Absent: none. */
  jobArtifacts?: JobArtifacts;
  /** The user's issue graph (issue #437): each listed issue's place is kept there. Absent: none is kept. */
  issueGraph?: IssueGraphRecorder;
  /** The listing cache (issue #985): the user's store. Absent: kept in memory. */
  listings?: GitHubListingRepository;
  /** The intake sync interval, in ms, read at each discover (issue #985). Default: DEFAULT_RATE_LIMITER's. */
  listingEveryMs?: () => number;
}

export const MIGRATION_RELEASED = 'released a claim with no holder recorded and no job in this hopper';
export const MIGRATION_UNASSIGNED = 'not assigned to you: assign it to you to take it';


export const CONFIG_URL = 'https://github.com/settings/installations';
export const CREATE_APP_HINT = 'create the app (scripts/create-github-app.sh), set its appId and slug on the github-app instance in Plugins and its key in GITHUB_APP_PRIVATE_KEY';

export function createGitHubSource(o: GitHubSourceOptions): JobSource {
  const { config } = o;
  const listings = o.listings ?? memoryListings();
  const reads = listedReads(o.api, listings);
  const { api } = reads;
  const listingEveryMs = o.listingEveryMs ?? (() => DEFAULT_RATE_LIMITER.intakeSyncMinutes * 60_000);
  const listing = createIntakeListing({ api, listings, clock: o.clock, everyMs: listingEveryMs });
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
  // The repos outside the scope (issue #440); the user's tagged items (issue #1141), read on their own timer, the intake sync interval.
  const outside = outsideReader(api, config); const tagged = taggedReader({ source: o.name, api, label: config.label, clock: o.clock, everyMs: listingEveryMs, ...(o.intake ? { intake: o.intake } : {}) });
  let lastDiscoverAt: string | undefined;
  let installedRepos: string[] = [];
  /** When the installed repositories were last asked (issue #985): a timed sync asks again only each intake sync interval. */
  let installedAt: number | undefined;
  let nothingToScan = false;
  /** The job repositories the last discover scanned: what a GitHub delivery may name (issue #1079). */
  let scanned: string[] = [];
  const labelledRepos = new Set<string>();
  /** The request cards this process saw opened, as `<key> <hash>`: the events are read once per text. */
  const opened = new Set<string>();
  /** Since when and by whom each issue is on the backburner (issue #808), read once while the label stays. */
  const backburner = backburnerReader(api);
  /** The pull requests the round's follows read first (issue #985). */
  const batch = followedBatch(api);
  /** What a follow, and the housekeeping of strays (issue #1143 part 4), need. */
  const census = pullRequestCensus(api, (repo) => o.landingBranch?.(repo));
  const followContext = (): FollowContext => ({ api, labelledRepos, clock: o.clock, batched: batch.take, ...(o.intake ? { holder: o.intake.holder } : {}), ...(o.yoloMode ? { yoloMode: o.yoloMode } : {}), ...(o.landingBranch ? { landingBranch: o.landingBranch } : {}), ...(o.changeRule ? { changeRule: o.changeRule } : {}) });

  /** App mode: the bot, once known (the app file, or the first sync). */
  let knownBot: string | undefined;
  const botLogin = async (): Promise<BotLogin> => {
    if (!app) return undefined;
    if (!api.botLogin) throw new Error('app mode needs the GitHub App adapter (no botLogin)');
    knownBot = await api.botLogin();
    return knownBot;
  };

  /**
   * The installation is the allowlist; config `repos`, when set, narrows it further. A timed sync (`due`) asks GitHub for it
   * only each intake sync interval, as the listing (issue #985); a sync a person asked for asks at once.
   */
  const appScope = async (due: boolean): Promise<string[]> => {
    if (!api.listInstalledRepos) throw new Error('app mode needs the GitHub App adapter (no listInstalledRepos)');
    const now = o.clock.now().getTime();
    if (!due || installedAt === undefined || now - installedAt >= listingEveryMs()) {
      installedRepos = (await api.listInstalledRepos()).map((r) => r.repo);
      installedAt = now;
    }
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
  const migrate = (intake: IntakeContext, released: string[], listed: IntakeOutcome[]) => {
    const changes: IntakeChange[] = [
      ...released.map((key) => ({ key, change: MIGRATION_RELEASED })),
      ...listed.filter((x) => x.reason === NOT_ASSIGNED).map((x) => ({ key: x.key, change: MIGRATION_UNASSIGNED })),
    ];
    intake.migrated({ at: o.clock.now().toISOString(), changes });
    intake.record('source.intake_migrated', { source: o.name, changes });
  };

  const writeBehind = createWriteBehind();
  const approvals = createApprovals({ source: o.name, api, trust: o.trust, recentComments: config.recentComments, assignee: () => o.assignee(), botLogin, writeBehind });

  return {
    name: o.name,
    kind: o.kind ?? o.name,
    thread: gitHubThread(api),
    intake: () => outcomes.map(writeBehind.on),
    intakeAction: async (a) => a.kind === 'dismiss' ? tagged.dismiss(a.keys) : intakeAct({ source: o.name, api, offered: outcomes, listedLabels, assignee: o.assignee(), intake: o.intake, trust: o.trust, approve: approvals.approve, label: config.label, takeIn: census.takeIn(), writeBehind }, a),
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
        ...outside.detail(), ...tagged.detail(), ...census.detail(writeBehind.of),
        ...(Object.keys(repoErrors).length ? { repoErrors } : {}),
        ...(Object.keys(checkErrors).length ? { checkErrors } : {}),
        ...(Object.keys(graphErrors).length ? { graphErrors } : {}),
        ...writeBehind.detail(),
        ...(lastDiscoverAt ? { lastDiscoverAt } : {}),
      };
    },
    discover: (d) => reads.cached(async () => {
      const round = await writeBehind.begin();
      const bot = await botLogin();
      const assignee = o.assignee();
      const repos = scanned = bot === undefined ? config.repos : await appScope(d?.due === true);
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
      const listed = await listing.issues(repos, config.label, d?.due === true);
      const found = await discoverIssues(api, config, {
        listed, assignee, ...(o.knownKeys ? { knownKeys: o.knownKeys } : {}), ...(o.rejections ? { rejections: o.rejections } : {}),
        ...(intake ? { holder: intake.holder, othersKnown: intake.othersKnown, migrating } : {}),
      });
      // The new listing is built apart and kept at the end, in one step (issue #1019): until then the intake is the last
      // sync's, so an Approve sent while this sync reads GitHub finds its request card, never a half-built list. A merge
      // on the landing branch waits on its batch run (issue #1175): done, and no reopened card. One its batch run promoted
      // with its issue still open (issue #1232): the issue is closed, once, and no reopened card.
      let next = await closePromoted(api, found.seen, awaitingBatch(found.outcomes, intake), intake);
      for (const r of found.released) intake?.record('source.claim_released', { source: o.name, key: r.key, by: r.by, reason: r.reason });
      if (intake && migrating && found.migrated) migrate(intake, found.released.filter((r) => r.by === 'migration').map((r) => r.key), next);
      if (listed.listed) await outside.read(repos, assignee); await tagged.read(repos, assignee, d?.due !== true);
      // A listing has no body: each issue taken is read, from GitHub only when its listing changed since.
      const taken: GitHubIssue[] = [];
      for (const i of found.issues) { const issue = await api.getIssue(i.repo, i.number); if (issue.state === 'open') taken.push(issue); }
      const projects = await readProjects(api, config, taken);
      projectErrors = projects.errors;
      const urls = taken.map((i) => i.url);
      const known = o.knownKeys && urls.length > 0 ? o.knownKeys(urls) : new Set<string>();
      const rerun = o.rerunnable && urls.length > 0 ? o.rerunnable(urls) : new Set<string>();
      // An issue whose job has not ended keeps it, unless that job waits for its origin (the backfill); any other is judged
      // by its origin (issue #652).
      const judged = taken.filter((i) => !known.has(i.url) || rerun.has(i.url) || o.trust.originPending(i.url));
      const verdicts = await originsOf(api, o.trust, judged, config.label, assignee);
      const requests = await reopenedRequests(api, found.seen, next, o.rerunnable, intake);
      const items: SourceItem[] = [];
      for (const issue of taken) {
        const v = verdicts.get(issue.url);
        if (v && 'request' in v) { requests.set(issue.url, v.request); continue; }
        const item = await toItem(issue, known, rerun, priorityOf(issue, config, projects.views.get(issue.repo)), bot, assignee);
        items.push(v ? { ...item, origin: v.origin } : item);
      }
      next = next.map((x) => requestOutcome(x, requests.get(x.key), o.trust));
      if (intake) { openRequests(o.name, intake, requests, opened); withdrawRequests(o.name, intake, requests, { repos, repoErrors: found.repoErrors }, opened); }
      next = await backburner(next);
      if (o.issueGraph && config.issueGraph) graphErrors = await recordIssueGraph({ api, graph: o.issueGraph, clock: o.clock, refreshMinutes: config.graphRefreshMinutes }, found.seen);
      repoErrors = found.repoErrors;
      outcomes = next;
      writeBehind.listed(round);
      listedLabels = found.listed;
      lastDiscoverAt = o.clock.now().toISOString();
      return items;
    }),
    repoChanged: (repo) => { const own = scanned.find((r) => r.toLowerCase() === repo.toLowerCase()); if (own !== undefined) listing.markDue(own); return own !== undefined; },
    check: (active) => reads.cached(async () => {
      const mine = active.filter((j) => j.source?.source === o.name && !TERMINAL_STATUSES.includes(j.status));
      if (mine.length === 0) return [];
      const r = await checkJobs(api, config, mine);
      checkErrors = r.errors;
      return r.signals;
    }),
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
    follow: (job, act) => followPullRequest(followContext(), job, act),
    housekeepStrays: (strays) => housekeepStrays(followContext(), strays), censusPullRequests: (facts) => census.read(scanned, facts),
    unfollowedPullRequests: (jobs) => unfollowedPullRequests(api, jobs), tendStarted: tendStartedOn(api),
    readFollowed: (jobs) => batch.read(jobs),
    crossReferences: (job) => crossReferencesOfJob(api, job),
    mergesOnReady: (repo, kind) => mergesOnReady(o.changeRule?.(repo) ?? DEFAULT_CHANGE_RULE, o.yoloMode?.(repo) ?? false, kind),
    issueState: (job) => issueState(api, job),
    workState: (job) => workState(api, job),
    pullRequestOpen: (job) => ownPullRequestOpen(api, job),
    ownPullRequestChecks: (job) => ownPullRequestChecks(api, job), rerunChecks: (failed) => rerunChecks(api, failed),
  };
}
