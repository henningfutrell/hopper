// The GitHub JobSource: open issues labelled `hopper` and assigned to the user's connected account become
// jobs (issue #387) when their origin is trusted — written, labelled and assigned by the user's trusted actors — or a
// person approved their text; any other is a request card (issue #652, origin.ts; a reopened issue too, issue #1126);
// what happens to them goes back as labels only (no comment); closes and unlabels come
// back as cancel signals; unassigning the account cancels a waiting job and flags a started one. `knownKeys` (wired by the sync loop) tells discover which claimed issues already have
// a local job; without it every claimed issue is skipped, so nothing is ever re-run blind.
//
// One identity (issue #1377): the connected account's user, through the hopper's GitHub App. It writes as that user and
// tells hopper comments by their marker. It lists only the job repositories; it never searches.
//
// Intake reads the listing cache (issue #985, `listing.ts`): the job repositories are listed again every intake sync
// interval, at once when a person asked for the sync, or at the next sync after a GitHub delivery said the repository
// changed (issue #1079, `repoChanged`). A discover and a check read a job's issue from what was kept
// while its listing shows no change (`listed-reads.ts`); every other read — before a write — goes to GitHub.
// Beside intake, a connected account's source reads the user's **tagged items** (issue #1141, `tagged.ts`).

import { issueChangeEvent } from '../../domain/work-items.ts';
import { RECONCILE_GRACE_MS } from '../../domain/item-lifecycle.ts';
import { commandAsks, commandOf } from '../../domain/comment-command.ts';
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
import { doneCriteriaHold, doneCriteriaMiss, partCriteriaMiss, type JobAllowedDeletes, type JobDoneCriteria } from './done-criteria.ts';
import { issueState, notComplete, ownPullRequestChecks, ownPullRequestOpen, partlyDone, unfinishedPullRequest, workState, type JobArtifacts, type WaitsOnBatch } from './completion.ts';
import { waitingOnBatch, waitsOnBatch } from './batch-wait.ts';
import { rerunChecks } from './rerun-checks.ts';
import { endedWatched, waitedChecks, waitedReviews } from './watched.ts';
import type { FollowContext } from './follow-context.ts';
import { endedPullRequests, followPullRequest, housekeepStrays, tendStartedOn } from './follow.ts';
import { crossReferencesOfJob } from './cross-references.ts';
import { unfollowedPullRequests } from './reconcile.ts';
import { pullRequestCensus } from './census.ts';
import { followedBatch } from './followed-batch.ts';
import { partsOf, tickedParts } from './parts.ts';
import { sendBack } from './rework.ts';
import { gitHubThread } from './thread.ts';
import { contextBlock, contextComments, issueEnv, issuePrompt, promptWithText, untrustedBlock } from './context.ts';
import { NOT_ASSIGNED, discoverIssues, type Rejection } from './discover.ts';
import { intakeAct } from './intake-actions.ts';
import { createApprovals } from './approvals.ts'; import { autoOutcome } from './auto-approve.ts';
import { createLabelMirror } from './label-mirror.ts'; import { handoffSettling } from './item-labels.ts';
import { actGaveUp, createGitHubOutbox, memoryGitHubOutbox, outboxSend } from './outbox.ts';
import { outsideReader } from './outside.ts';
import { priorityOf, readProjects } from './priority.ts';
import { awaitingBatch, closePromoted, declinedOutcome, openRequests, originsOf, reopenedRequests, requestOutcome, withdrawRequests } from './origin.ts';
import { backburnerReader } from './backburner.ts'; import { taggedReader } from './tagged.ts';
import { recordIssueGraph, type IssueGraphRecorder } from './graph.ts';
import { ensureLabels, keepResolution, reportToGitHub, takeBack, type LabelSink } from './report.ts';

/** What the source reads of its config. */
export type GitHubSourceSettings = Pick<GitHubSourceConfig,
  'repos' | 'label' | 'hopperName' | 'priorityLabels' | 'defaultPriority' | 'executor' | 'model' | 'recentComments' | 'projects' | 'issueGraph' | 'graphRefreshMinutes'
>;

export interface GitHubSourceOptions {
  name: string;
  /** Defaults to `name`. */
  kind?: string;
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
  /** The done criteria of the conditional skills a job got (issue #1924): checked on its own pull request before it is done. Absent: none. */
  doneCriteria?: JobDoneCriteria;
  /** The deletes a job's issue allows by resource address (issue #1924 part 2): a plan's delete of one does not count. Absent: none. */
  allowedDeletes?: JobAllowedDeletes;
  /** The user's issue graph (issue #437): each listed issue's place is kept there. Absent: none is kept. */
  issueGraph?: IssueGraphRecorder;
  /** The listing cache (issue #985) and the GitHub outbox (issue #1238): the user's store. Absent: kept in memory. */
  listings?: GitHubListingRepository; outbox?: import('../../domain/github-outbox.ts').GitHubOutboxRepository;
  /** The intake sync interval, in ms, read at each discover (issue #985). Default: DEFAULT_RATE_LIMITER's. */
  listingEveryMs?: () => number;
  /** Whether the connected account is connected and not expired (issue #1891): while not, the outbox's rows wait. Absent: always. */
  connected?: () => boolean;
}

export const MIGRATION_RELEASED = 'released a claim with no holder recorded and no job in this hopper';
export const MIGRATION_UNASSIGNED = 'not assigned to you: assign it to you to take it';


export function createGitHubSource(o: GitHubSourceOptions): JobSource {
  const { config } = o;
  const listings = o.listings ?? memoryListings();
  const reads = listedReads(o.api, listings);
  const { api } = reads;
  const listingEveryMs = o.listingEveryMs ?? (() => DEFAULT_RATE_LIMITER.intakeSyncMinutes * 60_000);
  const listing = createIntakeListing({ api, listings, clock: o.clock, everyMs: listingEveryMs });
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
  /** The job repositories the last discover scanned: what a GitHub delivery may name (issue #1079). */
  let scanned: string[] = [];
  const ensuredLabels = new Set<string>();
  /** The request cards this process saw opened, as `<key> <hash>`: the events are read once per text. */
  const opened = new Set<string>();
  /** Since when and by whom each issue is on the backburner (issue #808), read once while the label stays. */
  const backburner = backburnerReader(api);
  /** The pull requests the round's follows read first (issue #985). */
  const batch = followedBatch(api);
  /** What a follow, and the housekeeping of strays (issue #1143 part 4), need. */
  const census = pullRequestCensus(api, (repo) => o.landingBranch?.(repo));
  // A close the report finds is the ledger's too (issue #1892), once: a read, as the fallback read records it.
  const issueClosed = (key: string, reason: string | undefined) => {
    const item = o.intake?.workItem?.(key);
    const e = item && issueChangeEvent(item, { state: 'closed', ...(reason ? { reason } : {}) }, 'read');
    if (e?.type === 'work_item.issue_closed') o.intake?.record(e.type, e.data);
  };
  const reportContext = () => ({ api, ensuredLabels, issueClosed, ...(o.intake ? { holder: o.intake.holder } : {}) });
  const waitsOn: WaitsOnBatch = async (repo, n, since) => { const b = o.landingBranch?.(repo); return b !== undefined && waitsOnBatch(api, repo, b, n, o.clock.now().getTime(), since); };
  const followContext = (): FollowContext => ({ api, ensuredLabels, clock: o.clock, batched: batch.take, ...(o.intake ? { holder: o.intake.holder } : {}), ...(o.yoloMode ? { yoloMode: o.yoloMode } : {}), ...(o.landingBranch ? { landingBranch: o.landingBranch } : {}), ...(o.changeRule ? { changeRule: o.changeRule } : {}),
    ...(o.doneCriteria ? { mergeHold: (job, repo, url) => doneCriteriaHold(api, job, repo, url, o.doneCriteria, o.allowedDeletes) } : {}), labels: labelRows('follow') });
  /** A follow's or a report's label change (issue #1892 parts 14 and 15): outbox rows, once per end, sent in its own pass. */
  const labelRows = (act: 'follow' | 'report'): LabelSink => async (key, repo, change, tag, replaces) => {
    if (replaces !== undefined) outbox.drop(act, key, replaces);
    if (outbox.sent(act, key, tag)) return;
    outbox.queue(act, key, repo, [
      ...(change.remove.length ? [{ change: { op: 'remove_labels' as const, labels: change.remove } }] : []),
      ...(change.add.length ? [{ change: { op: 'add_labels' as const, labels: change.add } }] : []),
    ], { tag });
    await outbox.sendOf(act, key, outboxSend(api, approvals.readComments, (r, labels) => ensureLabels(reportContext(), r, labels)));
  };

  /**
   * The issue's declared parts and how many are done (issue #729). Its merged parts cannot be read now: the ticked ones
   * only, read again next sync.
   */
  const issueParts = (issue: GitHubIssue) => partsOf(api, issue).catch(() => tickedParts(issue));

  const toItem = async (issue: GitHubIssue, known: Set<string>, rerun: Set<string>, p: ReturnType<typeof priorityOf>, assignee: string | undefined): Promise<SourceItem> => {
    // An item whose job has not ended is offered only to follow its priority: its comments are not read (issue #662: its
    // text is compared without them).
    const unread = known.has(issue.url) && !rerun.has(issue.url) && config.recentComments !== 0;
    const comments = unread || config.recentComments === 0 ? [] : await api.listComments(issue.repo, issue.number);
    const seen = contextComments(comments, assignee, config.recentComments);
    // The account's comment command (issue #655 part 21): `research` or `propose` asks the job for that kind.
    const asks = assignee === undefined ? [] : commandAsks(commandOf(comments, assignee)?.verb ?? 'run');
    const untrusted = untrustedBlock(issue, seen, config.recentComments);
    const parts = await issueParts(issue);
    const context = contextBlock(issue, p, o.yoloMode?.(issue.repo) ?? false, parts);
    return {
      text: { title: issue.title, body: issue.body, ...(unread ? {} : { comments: seen.map((c) => ({ author: c.author, at: c.createdAt, body: c.body })) }) },
      key: issue.url, url: issue.url, title: issue.title, body: issue.body,
      prompt: issuePrompt(untrusted, context), env: issueEnv(issue),
      author: issue.author, ...(assignee !== undefined ? { assignee } : {}), priority: p.priority, priorityReason: p.reason,
      labels: issue.labels, repo: issue.repo, number: issue.number, ...(parts ? { parts } : {}), ...(asks.length ? { asks } : {}),
      executor: config.executor,
      ...(config.model ? { model: config.model } : {}),
      ...(issue.body.trim() === '' ? { invalid: 'empty issue body' } : {}),
    };
  };

  /** Who this source acts as on GitHub (glossary "Account"): the connected account's user. */
  const account = (paused: string | undefined): Account => ({
    service: 'github', ...(login ? { identity: login } : {}), detail: { via: CONNECTED_VIA }, ...(paused ? { problem: paused } : {}),
  });

  /** The intake migration (issue #440): once, listing the claims it released and the issues not assigned to the user. */
  const migrate = (intake: IntakeContext, released: string[], listed: IntakeOutcome[]) => {
    const changes: IntakeChange[] = [
      ...released.map((key) => ({ key, change: MIGRATION_RELEASED })),
      ...listed.filter((x) => x.reason === NOT_ASSIGNED).map((x) => ({ key: x.key, change: MIGRATION_UNASSIGNED })),
    ];
    intake.migrated({ at: o.clock.now().toISOString(), changes });
    intake.record('source.intake_migrated', { source: o.name, changes });
  };

  // Take into Intake sent (issue #1238): its pull request's row follows it, before the next census.
  const outbox = createGitHubOutbox({ source: o.name, rows: o.outbox ?? memoryGitHubOutbox(), clock: o.clock, ...(o.intake ? { record: o.intake.record } : {}), ...(o.connected ? { connected: o.connected } : {}), sent: (r) => { if (r.act === 'take_in' && !outbox.held(r.key)) census.takenIn(r.key); } });
  const workItem = o.intake?.workItem;
  // Each item given back (Run again, Rework; issue #1892): when its give-back ended, or Infinity while it runs. Until the
  // grace after it the mirror does not judge the item: the new job's `job.queued` is on its way and moves it.
  const givenBack = new Map<string, number>();
  const giving = async <T>(job: { source?: { key: string } }, give: () => Promise<T>): Promise<T> => {
    const key = job.source?.key;
    if (key === undefined) return give();
    outbox.dropLabelRows(key);
    givenBack.set(key, Infinity);
    try { return await give(); } finally { givenBack.set(key, o.clock.now().getTime()); }
  };
  const busy = (key: string) => { const at = givenBack.get(key); if (at === undefined) return false; if (at + RECONCILE_GRACE_MS > o.clock.now().getTime()) return true; givenBack.delete(key); return false; };
  let mirrorStarted = false;
  const mirror = workItem ? createLabelMirror({ source: o.name, outbox, item: workItem, listedAt: (repo) => listings.listing(repo)?.fetchedAt, part: (key) => o.intake?.partOpen?.(key) ?? false, failureReported: (key) => o.intake?.failureReported?.(key) ?? false, partsLeft: (key) => o.intake?.partsLeft?.(key) ?? false, dropReported: (key) => o.intake?.dropReported?.(key), busy, now: () => o.clock.now().toISOString(), log: (line) => console.warn(line), record: (type, data) => o.intake?.record(type, data) }) : undefined;
  const approvals = createApprovals({ source: o.name, api, trust: o.trust, recentComments: config.recentComments, assignee: () => o.assignee(), outbox, label: config.label, scope: () => (scanned.length ? scanned : config.repos), known: (key) => o.knownKeys?.([key]).has(key) ?? false });

  return {
    name: o.name, kind: o.kind ?? o.name,
    thread: gitHubThread(api),
    intake: () => outbox.on(approvals.on(outcomes)), afterAnswerTimings: outbox.timings, releaseOutbox: outbox.release, flushOutbox: (acts) => outbox.flush(outboxSend(api, approvals.readComments, (repo, labels) => ensureLabels(reportContext(), repo, labels), acts), actGaveUp(acts)),
    pullRequestAct: (job, act, acting) => (job.source?.repo ? outbox.pullRequestAct(job.source.key, job.source.repo, act, job.id, acting) : undefined),
    giveBackAct: (job, act, acting, more) => (job.source?.repo ? outbox.giveBackAct(job.source.key, job.source.repo, act, job.id, acting, more) : undefined),
    intakeAction: async (a) => a.kind === 'dismiss' ? tagged.dismiss(a.keys) : a.kind === 'tagged_start' && a.started ? tagged.start(a.started) : intakeAct({ source: o.name, offered: approvals.on(outcomes), listedLabels, assignee: o.assignee(), intake: o.intake, trust: o.trust, approve: approvals.approve, resolve: approvals.resolve, label: config.label, priorityLabels: Object.keys(config.priorityLabels), takeIn: census.takeIn(), outbox }, a),
    ...(o.paused ? { paused: o.paused } : {}),
    describe() {
      const paused = o.paused?.();
      return {
        ...(login ? { login } : {}),
        account: account(paused),
        ...(paused ? { paused } : {}),
        repos: config.repos, ...(o.assignee() ? { assignee: o.assignee() } : {}), label: config.label, hopperName: config.hopperName, projectErrors,
        ...(o.intake?.migration() ? { intakeMigration: o.intake.migration() } : {}),
        ...outside.detail(), ...tagged.detail(), ...census.detail(outbox.of),
        ...(Object.keys(repoErrors).length ? { repoErrors } : {}),
        ...(Object.keys(checkErrors).length ? { checkErrors } : {}),
        ...(Object.keys(graphErrors).length ? { graphErrors } : {}),
        ...outbox.detail(),
        ...(lastDiscoverAt ? { lastDiscoverAt } : {}),
      };
    },
    discover: (d) => reads.cached(async () => {
      const round = outbox.begin();
      const assignee = o.assignee();
      const repos = scanned = config.repos;
      if (assignee === undefined) {
        repoErrors = {};
        outcomes = [];
        listedLabels = new Map();
        projectErrors = {};
        lastDiscoverAt = o.clock.now().toISOString();
        return [];
      }
      const intake = o.intake;
      const migrating = intake !== undefined && intake.migration() === undefined;
      // After a start, the mirror takes what the listing cache kept before this sync lists again (issue #1892).
      if (mirror && !mirrorStarted) { mirrorStarted = true; for (const r of repos) { const l = listings.listing(r); if (l) mirror.start(l.items.filter((i) => i.kind === 'issue' && i.labels.includes(config.label)), l.fetchedAt); } }
      const listed = await listing.issues(repos, config.label, d?.due === true);
      // Of the hoppers on one database, only the holder of the mirror's lease judges (issue #1892): another writes nothing.
      const judging = intake?.mirrorHeld?.() !== false;
      // An end label a person took off by hand is their Run again (issue #1892), found before Intake reads the ledger.
      const edited = mirror?.edits(listed.issues, judging);
      const found = await discoverIssues(api, config, {
        listed, assignee, ...(o.knownKeys ? { knownKeys: o.knownKeys } : {}), ...(o.rejections ? { rejections: o.rejections } : {}),
        ...(intake ? { holder: intake.holder, othersKnown: intake.othersKnown, migrating } : {}),
        ...(workItem ? { item: workItem, part: (key: string) => intake?.partOpen?.(key) ?? false, failureReported: (key: string) => (intake?.failureReported?.(key) ?? false) && !handoffSettling(workItem(key), o.clock.now().getTime()), partsLeft: (key: string) => intake?.partsLeft?.(key) ?? false, dropReported: (key: string) => intake?.dropReported?.(key), ...(edited ? { edited } : {}) } : {}),
      });
      // The new listing is built apart and kept at the end, in one step (issue #1019): until then the intake is the last
      // sync's, so an Approve sent while this sync reads GitHub finds its request card, never a half-built list. A merge
      // on the landing branch waits on its batch run (issue #1175): done, and no reopened card. One its batch run promoted
      // with its issue still open (issue #1232): the issue is closed, once, and no reopened card.
      let next = await closePromoted(api, found.seen, awaitingBatch(found.outcomes, intake), intake);
      for (const r of found.released) intake?.record('source.claim_released', { source: o.name, key: r.key, by: r.by, reason: r.reason });
      if (intake && migrating && found.migrated) migrate(intake, found.released.filter((r) => r.by === 'migration').map((r) => r.key), next);
      if (listed.listed) await outside.read(repos, assignee); await tagged.read(repos, assignee, d?.due !== true);
      // A listing has no body: each issue taken is read, from GitHub only when its listing changed since. One whose outbox
      // rows are not sent yet waits for them (issue #1238): Approve's comments, `hopper:done` gone, the claim released.
      const taken: GitHubIssue[] = [];
      for (const i of found.issues) { if (outbox.held(i.url)) continue; const issue = await api.getIssue(i.repo, i.number); if (issue.state === 'open') taken.push(issue); }
      const projects = await readProjects(api, config, taken);
      projectErrors = projects.errors;
      const urls = taken.map((i) => i.url);
      const known = o.knownKeys && urls.length > 0 ? o.knownKeys(urls) : new Set<string>();
      const rerun = o.rerunnable && urls.length > 0 ? o.rerunnable(urls) : new Set<string>();
      // Waits on its batch, read from GitHub (issue #1337): neither offered nor run again, whatever the ledger says.
      const waits = await waitingOnBatch(api, o.landingBranch, o.clock.now().getTime(), next, found.seen, taken.filter((i) => !known.has(i.url) || rerun.has(i.url)));
      next = waits.outcomes;
      // An issue whose job has not ended keeps it, unless that job waits for its origin (the backfill); any other is judged
      // by its origin (issue #652).
      const judged = taken.filter((i) => !waits.waiting.has(i.url) && (!known.has(i.url) || rerun.has(i.url) || o.trust.originPending(i.url)));
      const verdicts = await originsOf(api, o.trust, judged, config.label, assignee, found.nominated);
      const requests = await reopenedRequests(api, found.seen, next, o.rerunnable, intake);
      const items: SourceItem[] = [];
      for (const issue of taken.filter((i) => !waits.waiting.has(i.url))) {
        const v = verdicts.get(issue.url);
        if (v && 'request' in v) { requests.set(issue.url, v.request); continue; }
        const item = await toItem(issue, known, rerun, priorityOf(issue, config, projects.views.get(issue.repo)), assignee);
        items.push(v ? { ...item, origin: v.origin, originActs: v.acts, ...(v.visibility ? { visibility: v.visibility } : {}), ...(v.linkedPulls ? { linkedPulls: v.linkedPulls } : {}) } : item);
      }
      // A card a rule approves (issue #1268) is the hopper's approval, no card: the next sync takes it.
      const autos = await approvals.auto(requests, [...taken, ...found.seen]); next = next.map((x) => autoOutcome(x, autos.get(x.key)) ?? requestOutcome(x, requests.get(x.key), o.trust));
      next = next.map((x) => (outbox.declining(x.key) ? declinedOutcome(x) : x));
      if (intake) { openRequests(o.name, intake, requests, opened); withdrawRequests(o.name, intake, requests, { repos, repoErrors: found.repoErrors }, opened); }
      next = await backburner(next);
      if (o.issueGraph && config.issueGraph) graphErrors = await recordIssueGraph({ api, graph: o.issueGraph, clock: o.clock, refreshMinutes: config.graphRefreshMinutes }, found.seen);
      // An issue taken as a new job is not judged (issue #1954): its job moves the item; an end label put back keeps it out.
      const taking = new Set(items.map((i) => i.key).filter((k) => !known.has(k) || rerun.has(k)));
      if (judging) mirror?.check(found.seen.filter((i) => !taking.has(i.url)));
      repoErrors = found.repoErrors;
      outcomes = next; approvals.listed(next);
      outbox.listed(round);
      listedLabels = found.listed;
      lastDiscoverAt = o.clock.now().toISOString();
      return items;
    }),
    repoChanged: (repo) => { const own = scanned.find((r) => r.toLowerCase() === repo.toLowerCase()); if (own !== undefined) listing.markDue(own); return own !== undefined; },
    adopts: (job) => { const repo = job.source?.repo?.toLowerCase(); return repo !== undefined && scanned.some((r) => r.toLowerCase() === repo); }, check: (active) => reads.cached(async () => {
      const mine = active.filter((j) => j.source?.source === o.name && !TERMINAL_STATUSES.includes(j.status));
      if (mine.length === 0) return [];
      const r = await checkJobs(api, config, mine);
      checkErrors = r.errors;
      return r.signals;
    }),
    report(r) {
      return reportToGitHub({ ...reportContext(), labels: labelRows('report') }, r);
    },
    rerun: (job) => giving(job, async () => {
      const issue = await takeBack(reportContext(), config.label, job, o.assignee());
      const projects = await readProjects(api, config, [issue]);
      return toItem(issue, new Set(), new Set(), priorityOf(issue, config, projects.views.get(issue.repo)), o.assignee());
    }),
    rework: (job) => giving(job, async () => {
      const back = await sendBack(reportContext(), config.label, job, o.assignee());
      const projects = await readProjects(api, config, [back.issue]);
      const item = await toItem(back.issue, new Set(), new Set(), priorityOf(back.issue, config, projects.views.get(back.issue.repo)), o.assignee());
      return { item, pullRequest: back.pullRequest, state: back.state };
    }),
    withText(item, text) {
      return { ...item, ...promptWithText(item, text, config.recentComments) };
    },
    async editsSince(item, since) {
      if (!api.issueEdits || item.repo === undefined || item.number === undefined) return [];
      return (await api.issueEdits(item.repo, item.number)).filter((e) => e.at > since);
    },
    resolved: (job, resolution) => keepResolution(outbox, job, resolution, o.intake?.holder),
    async notComplete(job) {
      const why = await notComplete(api, job, o.jobArtifacts, waitsOn);
      // Not done: a part's unmet done criteria say why in its place, and the job is no part done (issue #1924 part 4).
      if (why !== undefined) return (await partCriteriaMiss(api, job, o.doneCriteria, o.allowedDeletes)) ?? why;
      return doneCriteriaMiss(api, job, o.doneCriteria, o.allowedDeletes);
    },
    async partlyDone(job) {
      const part = await partlyDone(api, job);
      return part !== undefined && (await partCriteriaMiss(api, job, o.doneCriteria, o.allowedDeletes)) === undefined ? part : undefined;
    },
    unfinishedPullRequest(job) {
      return unfinishedPullRequest(api, job);
    },
    follow: (job, act, at) => followPullRequest(followContext(), job, act, at),
    housekeepStrays: (strays) => housekeepStrays(followContext(), strays), censusPullRequests: (facts) => census.read(scanned, facts),
    unfollowedPullRequests: (jobs) => unfollowedPullRequests(api, jobs), tendStarted: tendStartedOn(api),
    readFollowed: (jobs) => batch.read(jobs), endedPullRequests: (pulls) => endedPullRequests(api, pulls), endedWatched: (refs) => endedWatched(api, refs), waitedChecks: (repo, number) => waitedChecks(api, repo, number), waitedReviews: (repo, number) => waitedReviews(api, repo, number),
    crossReferences: (job) => crossReferencesOfJob(api, job),
    mergesOnReady: (repo, kind) => mergesOnReady(o.changeRule?.(repo) ?? DEFAULT_CHANGE_RULE, o.yoloMode?.(repo) ?? false, kind),
    issueState: (job) => issueState(api, job),
    workState: (job) => workState(api, job),
    pullRequestOpen: (job) => ownPullRequestOpen(api, job),
    ownPullRequestChecks: (job) => ownPullRequestChecks(api, job), rerunChecks: (failed) => rerunChecks(api, failed),
  };
}
