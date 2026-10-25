// The GitHub source over one source logic, as the job-source plugin builds it: a connected account's — `github-account`
// (issue #214), through the account the user signed in with or connected, by the hopper's GitHub App: the one way GitHub is
// read and written (issues #359, #1377: no App private key, no installation token). It pauses itself (JobSource.paused) while
// the account is not connected or its sign-in expired (issue #358) — then it asks for a sign-in again; nothing falls back
// to another credential —, or while no job repository is chosen.
import { SourceError, type Clock, type ConnectedAccountTokens, type JobSource } from '../domain/ports.ts';
import { CONNECTED_VIA, DEFAULT_CHANGE_RULE, furtherAccount, mergesOnReady, providerOfKey, type ChangeRule, type ConnectedAccountKey } from '../domain/types.ts';
import type { DirectPullRequests } from '../domain/direct-jobs.ts';
import { endedPullRequests, tendStartedOn } from './github/follow.ts';
import { endedWatched, waitedChecks, waitedReviews } from './github/watched.ts';
import { followDirectPullRequest } from './github/direct-follow.ts';
import { notConnected } from '../connected-accounts/service.ts';
import { createAccountGitHubApi } from './github/account/api.ts';
import { GitHubApiError } from './github/api.ts';
import type { Rejection } from './github/discover.ts';
import type { JobArtifacts, JobOpenedPullRequests } from './github/completion.ts';
import type { IssueGraphRecorder } from './github/graph.ts';
import type { IntakeContext, IntakeTrust } from '../domain/intake.ts';
import type { GitHubApi } from './github/index.ts';
import { createGitHubSource } from './github/index.ts';
import { gitHubThread } from './github/thread.ts';
import { passReads } from './github/pass-reads.ts';
import { baseMergeOf, baseTipOf, conflictBetweenOf, gitAnswers } from './github/git-answers.ts';
import { createCheckLogs } from './github/check-logs.ts';
import { ACCOUNT_CONNECTION, checksFallback } from './github/checks-fallback.ts';
import type { GitMirrors } from '../git-mirror/mirrors.ts';
import { sourceConfig, type GitHubAccountOptions } from './config.ts';
import type { GitHubListingRepository } from '../domain/github-listing.ts';
import type { GitHubOutboxRepository } from '../domain/github-outbox.ts';
import { githubLimiter } from '../github-limiter/limiter.ts';
import type { FollowEvery } from './follow-rounds.ts';

/** A connected account's source lists only its job repositories (issue #321): none chosen, none listed. */
export const NO_REPOSITORIES = 'no repositories chosen for jobs: Sources → GitHub account → choose them';

export interface GitHubSourceDeps {
  /** The instance name: jobs and sync state are keyed by it. */
  name: string;
  clock: Clock;
  knownKeys: (keys: string[]) => Set<string>;
  rerunnable: (keys: string[]) => Set<string>;
  /** Of the keys, those whose newest job was rejected: when, and the assignee it was taken for (issue #387). */
  rejections?: (keys: string[]) => Map<string, Rejection>;
  /** A double at the GitHubApi seam (tests). */
  api?: GitHubApi;
  /** The user's connected accounts (issue #214). */
  accounts?: ConnectedAccountTokens;
  /** Claim holders, the intake migration and intake events for this source (issue #440). */
  intake?: IntakeContext | undefined;
  /** The user's trusted actors and approved requests (issue #652). */
  trust: IntakeTrust;
  /** The user's yolo mode for a repository (issue #579); absent: off. */
  yoloMode?: (repo: string) => boolean;
  /** Whether the hopper merges nothing in a repository (issue #2752); absent: never. */
  needsMerge?: (repo: string) => boolean;
  /** A repository's landing branch (issue #1143); absent or undefined: no pull request is moved. */
  landingBranch?: (repo: string) => string | undefined;
  /** The change rule of a repository (issue #1076); absent: the built-in rule. */
  changeRule?: (repo: string) => ChangeRule;
  /** The artifacts a job made (issue #673): what makes an artifact-only issue done. */
  jobArtifacts?: JobArtifacts;
  /** The pull requests a job opened through the hopper (issue #2510): its report and follow link its own. */
  openedPullRequests?: JobOpenedPullRequests;
  /** The user's issue graph (issue #437). */
  issueGraph?: IssueGraphRecorder;
  /** The user's mirrors of the job repositories (issue #858): git says whether a pull request has conflicts. Absent: GitHub says. */
  gitMirrors?: GitMirrors;
  /** The user's listing cache (issue #985). Absent: kept in memory. */
  listings?: GitHubListingRepository;
  /** The user's GitHub outbox (issue #1238). Absent: kept in memory. */
  outbox?: GitHubOutboxRepository;
}

/** The in-motion cycle's intervals (issue #985), as the hopper's admin set them: the cycle, and every followed pull request each intake sync interval. */
export const followEvery = (): FollowEvery => {
  const s = githubLimiter.settings();
  return { cycleMs: s.prCycleMinutes * 60_000, allMs: s.intakeSyncMinutes * 60_000 };
};

/** What the source keeps in the store (issues #985, #1238): the listing cache, the outbox, and the intake sync interval the hopper's admin set. */
const listingOf = (o: GitHubSourceDeps) => ({
  ...(o.listings ? { listings: o.listings } : {}), ...(o.outbox ? { outbox: o.outbox } : {}), listingEveryMs: () => githubLimiter.settings().intakeSyncMinutes * 60_000,
});

/**
 * A connected account's source (issue #214): the GitHub source logic over the account the user
 * connected, rebuilt when the account or its job repositories change — it takes the issues assigned to that login.
 * It lists only the job repositories (issue #321), read at each call, never a search over all the account
 * can reach. Paused, and saying why, while none is connected, its token expired (sign in again), or no
 * repository is chosen; a report then waits for a connection (transient).
 */
export function createAccountSource(o: GitHubSourceDeps & { key: ConnectedAccountKey; accounts: ConnectedAccountTokens },
  options: GitHubAccountOptions): JobSource {
  // `provider`: the account's key (issue #1448), what every ask of the connected accounts names; its kind is its provider's.
  const { key: provider, accounts } = o;
  const kind = `${providerOfKey(provider)}-account`;
  // The token at each call: a disconnect stops the next call, not only the next sync.
  const token = async (): Promise<string> => {
    try { return await accounts.token(provider); } catch (err) { throw new GitHubApiError((err as Error).message, false); }
  };
  // One read per sync pass (issue #822), across a rebuild of the source too; conflicts from the mirror (issue #858); checks
  // the rollup would not give, read again over REST (issue #1244).
  const account = o.api ?? createAccountGitHubApi({ ...accounts.endpoints(provider), token, renew: (refused) => accounts.renew(provider, refused) });
  const reads = passReads(gitAnswers(checksFallback(account, ACCOUNT_CONNECTION, () => o.clock.now().getTime()), o.gitMirrors), o.name);
  const api = reads.api;
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
          name: o.name, kind, whoami: login, assignee: () => login, config, api, clock: o.clock, trust: o.trust,
          knownKeys: o.knownKeys, rerunnable: o.rerunnable, ...(o.rejections ? { rejections: o.rejections } : {}),
          ...(o.intake ? { intake: o.intake } : {}), ...(o.yoloMode ? { yoloMode: o.yoloMode } : {}), ...(o.needsMerge ? { needsMerge: o.needsMerge } : {}), ...(o.landingBranch ? { landingBranch: o.landingBranch } : {}), ...(o.changeRule ? { changeRule: o.changeRule } : {}), ...(o.jobArtifacts ? { jobArtifacts: o.jobArtifacts } : {}), ...(o.openedPullRequests ? { openedPullRequests: o.openedPullRequests } : {}),
          ...(o.issueGraph ? { issueGraph: o.issueGraph } : {}), ...listingOf(o), connected: () => accounts.account(provider) !== undefined,
        }),
      };
    }
    return built.source;
  };
  // `expired`: the sign-in ended (issue #441), so the UI asks to connect again on every screen. Not while its
  // tokens cannot be opened (issue #514): that asks for the key, never a new grant.
  // Why nothing goes through the account: its sign-in ended (issue #518: never "not connected" then), or none is.
  const why = () => accounts.ended(provider) ?? notConnected(providerOfKey(provider));
  const unconnected = () => ({
    repos: accounts.jobRepositories(provider), label: options.label,
    account: { service: providerOfKey(provider), detail: { via: CONNECTED_VIA }, problem: why() },
    ...(accounts.expired(provider) ? { expired: true } : {}),
  });
  return {
    name: o.name,
    kind,
    // The issue thread goes through the account's own api (issue #435): a disconnect stops its next call.
    thread: gitHubThread(api),
    paused: () => (!current() ? why() : accounts.jobRepositories(provider).length === 0 ? NO_REPOSITORIES : undefined),
    // A further account's source (issue #1448) names its account, so Sources shows it in that account's panel.
    describe: () => ({ ...(current()?.describe() ?? unconnected()), ...(furtherAccount(provider) ? { accountKey: provider } : {}) }),
    afterAnswerTimings: () => current()?.afterAnswerTimings?.() ?? [],
    pass: reads.pass,
    passCalls: reads.calls,
    discover: (d) => current()?.discover(d) ?? Promise.resolve([]),
    repoChanged: (repo) => current()?.repoChanged?.(repo) ?? false,
    adopts: (job) => current()?.adopts?.(job) ?? false,
    check: (active) => current()?.check(active) ?? Promise.resolve([]),
    report(r) {
      const s = current();
      return s ? s.report(r) : Promise.reject(new SourceError(why(), false));
    },
    notComplete(job) {
      const s = current();
      return s?.notComplete ? s.notComplete(job) : Promise.reject(new Error(why()));
    },
    issueState(job) {
      const s = current();
      return s?.issueState ? s.issueState(job) : Promise.reject(new Error(why()));
    },
    workState(job) {
      const s = current();
      return s?.workState ? s.workState(job) : Promise.reject(new Error(why()));
    },
    ownPullRequestChecks(job) {
      const s = current();
      return s?.ownPullRequestChecks ? s.ownPullRequestChecks(job) : Promise.reject(new Error(why()));
    },
    rerunChecks(failed) {
      const s = current();
      return s?.rerunChecks ? s.rerunChecks(failed) : Promise.reject(new Error(why()));
    },
    partlyDone(job) {
      const s = current();
      return s?.partlyDone ? s.partlyDone(job) : Promise.reject(new Error(why()));
    },
    unfinishedPullRequest(job) {
      const s = current();
      return s?.unfinishedPullRequest ? s.unfinishedPullRequest(job) : Promise.reject(new Error(why()));
    },
    follow(job, act, at) {
      const s = current();
      return s?.follow ? s.follow(job, act, at) : Promise.reject(new SourceError(why(), false));
    },
    readFollowed(jobs) {
      const s = current();
      return s?.readFollowed ? s.readFollowed(jobs) : Promise.reject(new SourceError(why(), false));
    },
    unfollowedPullRequests(jobs) {
      const s = current();
      return s?.unfollowedPullRequests ? s.unfollowedPullRequests(jobs) : Promise.reject(new SourceError(why(), false));
    },
    crossReferences(job) {
      const s = current();
      return s?.crossReferences ? s.crossReferences(job) : Promise.reject(new SourceError(why(), false));
    },
    housekeepStrays(strays) {
      const s = current();
      return s?.housekeepStrays ? s.housekeepStrays(strays) : Promise.reject(new SourceError(why(), false));
    },
    readCompanions(pulls) {
      const s = current();
      return s?.readCompanions ? s.readCompanions(pulls) : Promise.reject(new SourceError(why(), false));
    },
    endedPullRequests(pulls) {
      const s = current();
      return s?.endedPullRequests ? s.endedPullRequests(pulls) : Promise.reject(new SourceError(why(), false));
    },
    endedWatched(refs) {
      const s = current();
      return s?.endedWatched ? s.endedWatched(refs) : Promise.reject(new SourceError(why(), false));
    },
    waitedChecks(repo, number) {
      const s = current();
      return s?.waitedChecks ? s.waitedChecks(repo, number) : Promise.reject(new SourceError(why(), false));
    },
    waitedReviews(repo, number) {
      const s = current();
      return s?.waitedReviews ? s.waitedReviews(repo, number) : Promise.reject(new SourceError(why(), false));
    },
    censusPullRequests(facts) {
      const s = current();
      return s?.censusPullRequests ? s.censusPullRequests(facts) : Promise.reject(new SourceError(why(), false));
    },
    // Unconnected, nothing is said on the pull request (issue #1143): a note never throws.
    tendStarted: async (job, pullRequest, step) => { await current()?.tendStarted?.(job, pullRequest, step); },
    // Unconnected, nothing is merged (issue #796), and nothing is said of conflicts (issue #939).
    mergesOnReady: (repo, kind) => current()?.mergesOnReady?.(repo, kind) ?? false,
    conflictBetween: conflictBetweenOf(api),
    baseMerge: baseMergeOf(api),
    baseTip: baseTipOf(api),
    // Failed checks' logs (issue #993): through the account's own api, kept across a rebuild of the source.
    checkLogs: createCheckLogs(api).read,
    rerun(job) {
      const s = current();
      return s?.rerun ? s.rerun(job) : Promise.reject(new SourceError(why(), false));
    },
    rework(job) {
      const s = current();
      return s?.rework ? s.rework(job) : Promise.reject(new SourceError(why(), false));
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
    // Unconnected, the outbox waits (issue #1238): its rows stay pending until a connection sends them.
    flushOutbox: (acts) => current()?.flushOutbox?.(acts) ?? Promise.resolve({ due: 0, wrote: [] }),
    releaseOutbox: () => current()?.releaseOutbox?.(),
    pullRequestAct: (job, act, acting) => current()?.pullRequestAct?.(job, act, acting),
    giveBackAct: (job, act, acting, more) => current()?.giveBackAct?.(job, act, acting, more),
  };
}

/**
 * How the `direct` source follows a direct job's pull request (issue #1068): the follow over the user's own GitHub
 * connection — the one a job's GitHub proxy acts with (issue #1380) —, with their yolo mode, landing branches and change
 * rules. While no account is connected, or its sign-in ended, a follow throws and is asked again on a later sync, and
 * nothing is merged. The pull requests and items a direct job's wait names are read with it too (issue #1721).
 */
export function createDirectPullRequests(o: {
  accounts: ConnectedAccountTokens; clock: Clock; api?: GitHubApi;
  yoloMode: (repo: string) => boolean; landingBranch: (repo: string) => string | undefined; changeRule: (repo: string) => ChangeRule;
}): DirectPullRequests {
  const provider = 'github';
  const token = async (): Promise<string> => {
    try { return await o.accounts.token(provider); } catch (err) { throw new GitHubApiError((err as Error).message, false); }
  };
  const api = o.api ?? checksFallback(createAccountGitHubApi({ ...o.accounts.endpoints(provider), token, renew: (refused) => o.accounts.renew(provider, refused) }), ACCOUNT_CONNECTION, () => o.clock.now().getTime());
  const context = { api, ensuredLabels: new Set<string>(), clock: o.clock, yoloMode: o.yoloMode, landingBranch: o.landingBranch, changeRule: o.changeRule };
  const connected = (): boolean => o.accounts.account(provider) !== undefined;
  return {
    follow: (job, act) => followDirectPullRequest(context, job, act),
    // Unconnected, nothing is merged, and nothing is said on the pull request.
    mergesOnReady: (repo, kind) => connected() && mergesOnReady(o.changeRule(repo) ?? DEFAULT_CHANGE_RULE, o.yoloMode(repo), kind),
    tendStarted: async (job, pullRequest, step) => { if (connected()) await tendStartedOn(api)(job, pullRequest, step); },
    checkLogs: createCheckLogs(api).read,
    // A direct job's waits (issue #1721): no other source lists it, so the direct source reads them. Unconnected, none ended.
    endedPullRequests: async (pulls) => (connected() ? endedPullRequests(api, pulls) : []),
    endedWatched: async (refs) => (connected() ? endedWatched(api, refs) : []),
    // A direct job's wait on a pull request's checks or review (issue #2210); unconnected, the read fails and says why.
    waitedChecks: async (repo, number) => { if (!connected()) throw new SourceError(notConnected(provider), false); return waitedChecks(api, repo, number); },
    waitedReviews: async (repo, number) => { if (!connected()) throw new SourceError(notConnected(provider), false); return waitedReviews(api, repo, number); },
  };
}
