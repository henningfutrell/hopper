// One user's side of the GitHub proxy (issue #563, design.md "GitHub through the hopper"): what each of their jobs
// asks the hopper with — its proxy token under this user's link key, `hopper-gh`, the hopper's URL as its machine
// reaches it, and git's way to the hopper (issue #652) —, the check of a token a job shows, and this user's GitHub
// connection, which the hopper acts with for this user's own jobs, their requests and their git (issue #1380).
// The shrink guard (issue #1096) of their jobs' pushes: the push's lines from the user's mirror, with their own connection,
// judged at the percent of their settings, read at each push.
import { createInfraPlans, type InfraPlans } from '../infra-plans/service.ts';
import { createOutOfBandChanges, type OutOfBandChanges } from '../infra-plans/out-of-band.ts'; import { createTopology, type Topology } from '../infra-plans/topology.ts';
import type { Clock, ConnectedAccountTokens, JobProxyCredentials, UserStore } from '../domain/ports.ts';
import { DEFAULT_SHRINK_GUARD, shrinkReason, shrunkFiles } from '../domain/shrink-guard.ts';
import type { CheckFastForward, CountPushLines } from '../git-mirror/push-lines.ts';
import type { HoldsRequirements } from '../git-mirror/push-requirements-at.ts';
import { REQUIREMENTS_CLIENT, REQUIREMENTS_CLIENT_FILE, REQUIREMENTS_SCRIPT, REQUIREMENTS_SCRIPT_FILE, REQUIREMENTS_SCRIPT_VARIABLE } from '../github-proxy/requirements-script.ts'; import { HEAVY_CLIENT, HEAVY_CLIENT_FILE, HEAVY_SCRIPT, HEAVY_SCRIPT_FILE, HEAVY_SCRIPT_VARIABLE } from '../github-proxy/heavy-script.ts';
import { PUSH_REQUIREMENTS_EVALUATED, pushRequirementsGate, storeSummaries } from './push-requirements.ts'; import { pushRequirementOverride } from '../domain/direct-jobs.ts';
import { DEFAULT_CONTRIBUTION, DEFAULT_YOLO_MODE, directPushFor, pullRequestList, sourceItemOf, yoloModeFor, type ConnectedAccountKey, type Job, type MachineSnapshot, type PullRequestSeen, type SourceStatus, type User } from '../domain/types.ts';
import { everyJobRepository } from '../domain/job-repositories.ts';
import { ownsPullRequest } from './owns-pull-request.ts';
import { isGitLabItem } from '../domain/gitlab-account.ts';
import { GITLAB_GIT_PATH } from '../gitlab/git-broker.ts';
import { createReportGitHub, createReportSender, type ReportGitHub, type ReportSender } from '../bug-reports/index.ts';
import { createRepoChecks, createRepoChecksGitHub, type RepoChecksService } from '../repo-checks/index.ts';
import { createApprovalsGitHub, createPendingApprovals, type PendingApprovals } from '../pending-approvals/index.ts';
import { createActorsGitHub, type ActorsGitHub } from '../intake-actors/index.ts';
import { createPromotionGitHub } from '../promotions/github.ts';
import { userPromotions, type Promotions } from '../promotions/service.ts';
import { createIssueDrafts, type IssueDrafter, type IssueDrafts } from '../issue-drafts/index.ts';
import { ISSUE_DRAFT_TIMEOUT_MS } from '../domain/issue-drafts.ts';
import { createGitHubWatches, createWatchGitHub, type GitHubWatches } from '../github-watch/index.ts';
import {
  branchChecksWatcher, cleanupJobsWatcher, createComponentWatchers, createWatcherGitHub, intakeJobsWatcher, lanesJobsWatcher, ledgerGitHubWatcher, ledgerJobsWatcher, stackHealthWatcher, type ComponentWatchers,
} from '../component-watchers/index.ts';
import type { StackResources } from '../domain/stack-resources.ts';
import { createLandingBatchGitHub } from '../landing-batches/github.ts';
import { createLandingBatches, type LandingBatches } from '../landing-batches/runner.ts';
import { DEFAULT_LANDING_BATCHES, LANDING_BATCH_EVENT_TYPES, landingBranch } from '../domain/landing-batches.ts';
import { batchClosingIssues, MERGE_STANDS } from '../domain/work-item-landing.ts';
import { createLedgerFallbackRead, type LedgerFallbackRead } from '../work-items/fallback-read.ts';
import { SECRET_HELPER_VARIABLE } from '../client/vault.ts';
import { LOGIN_SCRIPT, LOGIN_SCRIPT_FILE, LOGIN_SCRIPT_VARIABLE } from '../logins/script.ts';
import { SKILL_SCRIPT, SKILL_SCRIPT_FILE, SKILL_SCRIPT_VARIABLE } from '../skills/script.ts'; import { RELAY_CLIENT, RELAY_CLIENT_FILE, RELAY_SCRIPT, RELAY_SCRIPT_FILE, RELAY_SCRIPT_VARIABLE } from '../sandbox/relay-script.ts'; import { workSkillCredentials } from '../domain/skill-library.ts'; import { jobSkillsOf } from '../skill-library/index.ts'; import { conditionalSkillsCredentials } from '../domain/conditional-skills.ts'; import { createSkillSourceGitHub } from '../skill-library/github.ts'; import type { SkillSource } from '../skill-library/import.ts'; import { createScheduleSourceGitHub, type ScheduleSourceGitHub } from '../step-schedules/github.ts';
import { ARTIFACT_SCRIPT, ARTIFACT_SCRIPT_FILE, ARTIFACT_SCRIPT_VARIABLE } from '../artifacts/script.ts';
import { STEP_SCRIPT, STEP_SCRIPT_FILE, STEP_SCRIPT_VARIABLE } from '../windows-steps/script.ts';
import {
  createProxyApi, type ProxyApi, holdsProxyToken, isPullRequest, itemOf, knownPullRequest, type KnownPullRequest, jobGitConfig, type GitUser, proxyToken, PROXY_SCRIPT, PROXY_SCRIPT_FILE, PROXY_SCRIPT_VARIABLE, PROXY_TOKEN_FILE, PROXY_TOKEN_VARIABLE,
  PROXY_URL_VARIABLE, type ProxyConnection, type ProxyUser, createSubIssueLinker, createSubIssueLinks, replayOfIssue, sendingSince, type SubIssueLinks, PUSH_EVENTS,
} from '../github-proxy/index.ts';

/** No AI connection (issue #471): File an issue says so, and drafts nothing. */
const NO_DRAFTER: IssueDrafter = { provider: 'claude', available: async () => ({ ok: false, reason: 'no AI connection to draft with' }), draft: async () => ({ error: 'no AI connection to draft with' }) };


/** A user's side of the GitHub proxy: their jobs as askers, and their GitHub connection, which acts for their jobs and their jobs' git. */
export interface UserGitHubProxy {
  user: ProxyUser;
  connection: ProxyConnection;
  git: GitUser;
  /** Report a bug (issue #694): this user's own GitHub connection, so a report is filed as this user; or why there is none. */
  reports(): ReportGitHub | { problem: string };
  /** A person's reads of a job repository's pull request (issue #1169: its diff): this user's own connection — the account of `repo` (issue #1448) —, or why there is none. */
  reads(repo?: string): ProxyApi | { problem: string };
  /**
   * Repositories with no checks (issue #677): read with this user's own GitHub connection, kept in their store (issue
   * #1250); its schedule reads with the user's runtime.
   */
  repoChecks: RepoChecksService;
  /** Pending approvals (issue #2088): each connected account's waiting deployment approvals, read with its own connection; its schedule reads with the user's runtime. */
  pendingApprovals: PendingApprovals;
  /** The trusted actor picker (issue #930): this user's own GitHub connection and its login, or why there is none. */
  actors(): { api: ActorsGitHub; login: string } | { problem: string };
  /** Promote to GitHub (issue #946): this user's direct jobs posted with this user's own GitHub connection, never a job's. */
  promotions: Promotions;
  /**
   * File an issue (issue #471): drafted with this user's own signed-in Claude, filed after their confirmation with their
   * own connection — the account of the repository —, on one of their job repositories.
   */
  issueDrafts: IssueDrafts;
  /** The required children's sub-issue links GitHub refused, tried again until made (issue #1607); its loop runs with the user's runtime. */
  subIssueLinks: SubIssueLinks;
  /** Report a bug's kept reports sent later, and the filed ones' states read (issue #694); its loop runs with the user's runtime. */
  bugReports: ReportSender;
  /** The GitHub watches of this user's pointed jobs (issue #427), with this user's own connection; they poll with the user's runtime. */
  watches: GitHubWatches;
  /**
   * The component watchers (issue #1077): the ledger and the job repositories' default branches against GitHub with this
   * user's own connection, the ledger and the lanes against the job records, intake against the jobs and the sync timers,
   * the stack when this user is given it, and their drift issues; they check with the user's runtime.
   */
  componentWatchers: ComponentWatchers;
  /** Landing batches (issue #1073): batch runs of each landing branch, promoted to its tested branch, with this user's own connection; they run with the user's runtime. */
  landingBatches: LandingBatches;
  /** The work-item ledger's fallback read (issue #1067): quiet items' issues read with this user's own connection; it reads with the user's runtime. */
  ledgerFallbackRead: LedgerFallbackRead;
  /**
   * The infra plans (issue #870): what this user's jobs plan to change, a person's approvals, the vault's apply gate. Here
   * because the gate reads each plan's branch head on GitHub with this user's connection.
   */
  infraPlans: InfraPlans;
  /** The out-of-band changes (issue #871): what this user's jobs' checks report, a person's marks, the controller identities. The infrastructure topology (issue #1781). */
  outOfBand: OutOfBandChanges; topology: Topology;
  /** A library skill's folder read from a repository (issue #1911); a step schedule's folder (issue #2716): this user's own connection, the account of the repository. */
  skillSource: SkillSource; scheduleSource(repo: string): ScheduleSourceGitHub | { problem: string };
}

export interface UserGitHubProxyOptions {
  user: User;
  store: UserStore;
  clock: Clock;
  logger: { warn(line: string): void };
  /** The private half of the hopper's link key for this user (issue #308): the key its jobs' tokens are derived under. */
  linkPrivateKey: string;
  /** The user's connected accounts (issue #1448): each repository's account acts for it. */
  accounts: ConnectedAccountTokens & { keyFor(repo: string | undefined): ConnectedAccountKey; keys(): ConnectedAccountKey[] };
  /** The hopper's URL as a job on `machine` reaches it; undefined: it cannot, and its jobs get no proxy. */
  url(machine: MachineSnapshot): string | undefined;
  /** An artifact's stable URL, and the hopper's public URL (issue #946: a promotion's links are made only on it). */
  artifactUrl(id: string): string;
  publicUrl(): string | undefined;
  /** The job sources' statuses, each with its last intake (issue #1077: the intake-vs-jobs watcher reads them). */
  sources(): readonly SourceStatus[];
  /** The URL of the user's GitLab account (issue #1448 part 3); undefined: none attached. */
  gitlabUrl?(): string | undefined;
  /** The job's trace parent now (issue #1486 part 6), for its git; undefined: none. */
  traceparent?(jobId: string): string | undefined;
  /** The stack resources (issue #1077: the stack-health watcher reads them), given to the oldest user only; absent: none. */
  stack?: () => Promise<StackResources>;
  /** A push's lines, counted in the user's mirrors of the job repositories (issue #1096); absent: no shrink guard. */
  pushLines?: CountPushLines;
  /** Whether a direct push is a fast-forward (issue #1806), in the same mirrors; absent: no direct push is taken. */
  fastForward?: CheckFastForward;
  /** Whether a pushed commit holds a requirements file (issue #2555), in the same mirrors; absent: a push no job evaluated goes on. */
  holdsRequirements?: HoldsRequirements;
  /** File an issue's drafter (issue #471): the user's own AI connection; absent: none, so File an issue cannot draft. */
  issueDrafter?: IssueDrafter;
  /** The host name, masked in a job's context that File an issue attaches. */
  hostname?: string;
}

export function createUserGitHubProxy(o: UserGitHubProxyOptions): { githubProxy: UserGitHubProxy; jobProxy(job: Job, machine: MachineSnapshot): JobProxyCredentials | undefined } {
  const notConnected = 'GitHub is not connected: the job\'s user connects it in Sources → Connect GitHub';
  /** The connected account that acts for `repo` (issue #1448): the one whose job repositories hold it; else the first. */
  const keyOf = (repo?: string): ConnectedAccountKey => o.accounts.keyFor(repo);
  const api = (key: ConnectedAccountKey = 'github') => createProxyApi({
    apiUrl: o.accounts.endpoints(key).apiUrl,
    token: () => o.accounts.token(key),
    renew: (refused) => o.accounts.renew(key, refused),
  });
  /** Every connected account's job repositories (issue #1448). */
  const jobRepositories = (): string[] => [...new Set(o.accounts.keys().flatMap((k) => o.accounts.jobRepositories(k)))];
  /** Why the account of `key` cannot act now. */
  const notMineAt = (key: ConnectedAccountKey, why: string): string => o.accounts.ended(key) ?? why;
  const notMine = 'your GitHub is not connected: connect it in Sources → Connect GitHub';
  /** This user's own connection, for what they do themselves: Report a bug, the Add PR checks job. */
  const mine = () => ({ apiUrl: o.accounts.endpoints('github').apiUrl, installUrl: o.accounts.endpoints('github').installUrl, token: () => o.accounts.token('github'), renew: (refused: string) => o.accounts.renew('github', refused) });
  const reports = (): ReportGitHub | { problem: string } => (!o.accounts.account('github')
    ? { problem: o.accounts.ended('github') ?? notMine }
    : createReportGitHub(mine()));
  /** This user's Contribution (issue #429), read at each request: a change applies without a restart. */
  const contribution = () => (o.store.settings.getContribution() ?? DEFAULT_CONTRIBUTION).on;
  /** Where the user's mirror of `repo` fetches from, with the account of the repository (issues #1096, #1806). */
  const mirrorRemote = (repo: string) => async () => { const key = keyOf(repo); return { url: `${o.accounts.endpoints(key).url.replace(/\/+$/, '')}/${repo}.git`, token: await o.accounts.token(key) }; };
  /**
   * The shrink guard (issue #1096): a push's lines from the mirror, fetched with this user's own connection, judged at the
   * percent of the user's settings. Git cannot say: the push goes on, as it did before the guard.
   */
  const shrinkGuard = (pushLines: CountPushLines): NonNullable<GitUser['shrinkGuard']> => async (push) => {
    const lines = await pushLines(push.repo, mirrorRemote(push.repo), push);
    if (!lines?.brings) return { ok: true };
    const shrunk = shrunkFiles(lines.files, (o.store.settings.getShrinkGuard() ?? DEFAULT_SHRINK_GUARD).percent);
    return shrunk.length === 0 ? { ok: true } : { ok: false, shrunk, reason: shrinkReason(shrunk, push.base) };
  };
  /**
   * What this user's records know of a pull request (issue #1072): its card on the Pull requests list, as following it last
   * saw it — the same view a person reads —, and its work item in the ledger.
   */
  const pullRequest = (repo: string, number: number): KnownPullRequest => {
    const { store } = o;
    const view = pullRequestList(store.jobs.list({ status: ['finished', 'failed'], followed: true }), (key) => store.jobs.getBySourceKey(key), store.settings.getYoloMode() ?? DEFAULT_YOLO_MODE, everyJobRepository(store), o.clock.now().getTime(), (id) => store.jobs.get(id));
    const card = view.repos.flatMap((r) => r.pullRequests).find((c) => c.pullRequest && isPullRequest(c.pullRequest.url, repo, number));
    const url = card?.pullRequest?.url ?? `${o.accounts.endpoints('github').url.replace(/\/$/, '')}/${repo}/pull/${number}`;
    const followed = card ? store.jobs.get(card.jobId) : undefined;
    const item = store.workItems.byPullRequest(url) ?? (followed?.source ? store.workItems.get(followed.source.key) : undefined);
    const seen = (followed?.sourceState?.source as { seen?: PullRequestSeen } | undefined)?.seen;
    const known = knownPullRequest(number, url, { ...(card ? { card } : {}), ...(seen ? { seen } : {}), ...(item ? { item } : {}) });
    return { ...(known ? { known } : {}), ...(item ? { item: itemOf(item) } : {}) };
  };
  const summaries = storeSummaries(o.store, (repo) => (o.accounts.account(keyOf(repo)) === undefined ? { problem: notMineAt(keyOf(repo), notMine) } : api(keyOf(repo))), (l) => o.logger.warn(l));
  const user: ProxyUser = {
    id: o.user.id,
    // A job moved off a lost machine (issue #1569) holds the token of its newest move only: the agent left there is refused.
    // Gate 2's first step (issue #655): a job quarantined, or whose trust stamp does not verify, opens no door with it.
    holds: (parts) => {
      if (parts.userId !== o.user.id) return false;
      const job = o.store.jobs.get(parts.jobId);
      return holdsProxyToken(o.linkPrivateKey, parts, job?.movedAway ?? 0) && (job === undefined || o.store.jobs.opensDoors(job));
    },
    job: (id) => o.store.jobs.get(id),
    machineOf: (job) => o.store.lanes.list().find((l) => l.id === job.laneId)?.machineId,
    record: (event) => { o.store.events.append(event); },
    // What the work-item ledger says of an issue (its key) or a pull request (issue #1074): beside a repo query's answer.
    ledger: (url) => {
      const item = o.store.workItems.get(url) ?? o.store.workItems.byPullRequest(url);
      if (!item) return undefined;
      return {
        key: item.key, state: item.state, since: item.stateSince, ...(item.pullRequestState ? { pullRequestState: item.pullRequestState } : {}),
        ...(item.issueState ? { issueState: item.issueState } : {}), ...(item.issueReason ? { issueReason: item.issueReason } : {}),
      };
    },
    pullRequest,
    ownsPullRequest: (job, repo, number, op) => ownsPullRequest(o.store, job, repo, number, op),
    pushRequirementsSummary: summaries.of, // Issue #2555 part 4: the summary of the commit the job's newest push of the branch moved it to.
    // A fan-out key is the issue's (issue #1909): an earlier job of the same issue's answer too.
    replay: (jobId, key) => {
      const issue = o.store.jobs.get(jobId)?.source?.key;
      return replayOfIssue(o.store.events, jobId, key, (other) => issue !== undefined && o.store.jobs.get(other)?.source?.key === issue);
    },
    // A send a crash left with no answer (issue #1959 part 2), of the same scope as the replay's.
    sending: (jobId, key) => {
      const issue = o.store.jobs.get(jobId)?.source?.key;
      return sendingSince(o.store.events, jobId, key, (other) => issue !== undefined && o.store.jobs.get(other)?.source?.key === issue);
    },
  };
  /** Where a GitLab job's git goes (issue #1448 part 3): its user's GitLab, rewritten to the hopper's GitLab git route. */
  const gitlabOf = (job: Job): { url: string; path: string } | undefined => {
    const at = isGitLabItem(sourceItemOf(job)) ? o.gitlabUrl?.() : undefined;
    return at ? { url: at, path: GITLAB_GIT_PATH } : undefined;
  };
  return {
    jobProxy(job, machine) {
      const url = o.url(machine);
      if (!url) return undefined;
      // The job's work skill (issue #1911) and its conditional skills (issue #1924): the versions chosen at its first start, their files and the skills the work skill requires beside the scripts.
      const skills = jobSkillsOf(o.store, job); const work = workSkillCredentials(skills.work.skills);
      const more = conditionalSkillsCredentials(skills.conditional.map((c) => c.chosen), Object.fromEntries(skills.conditional.map((c) => [c.chosen.name, c.files]))); const skill = { files: { ...work.files, ...more.files }, paths: { ...work.paths, ...more.paths } };
      return {
        url,
        // `hopper-skill` (issue #582) asks with the same token: what the hopper can set up for this box; `hopper-artifact`
        // (issue #624) puts what the job makes for a person to see; `hopper-step` (issue #731) runs one step on a Windows host;
        // `hopper-login` (issue #1110) says what came of a login the job asked for; `hopper-relay` (issue #2146) joins a
        // local port to a target of the job's bastion; `hopper-requirements` (issue #2555) checks a push's requirements;
        // `hopper-heavy` (issue #2622) runs a heavy step when its host's memory holds it.
        files: { [PROXY_TOKEN_FILE]: proxyToken(o.linkPrivateKey, o.user.id, job.id, job.movedAway ?? 0), [PROXY_SCRIPT_FILE]: PROXY_SCRIPT, [SKILL_SCRIPT_FILE]: SKILL_SCRIPT, [ARTIFACT_SCRIPT_FILE]: ARTIFACT_SCRIPT, [STEP_SCRIPT_FILE]: STEP_SCRIPT, [LOGIN_SCRIPT_FILE]: LOGIN_SCRIPT, [RELAY_SCRIPT_FILE]: RELAY_SCRIPT, [RELAY_CLIENT_FILE]: RELAY_CLIENT, [REQUIREMENTS_SCRIPT_FILE]: REQUIREMENTS_SCRIPT, [REQUIREMENTS_CLIENT_FILE]: REQUIREMENTS_CLIENT, [HEAVY_SCRIPT_FILE]: HEAVY_SCRIPT, [HEAVY_CLIENT_FILE]: HEAVY_CLIENT, ...skill.files },
        paths: { [PROXY_TOKEN_VARIABLE]: PROXY_TOKEN_FILE, [PROXY_SCRIPT_VARIABLE]: PROXY_SCRIPT_FILE, [SKILL_SCRIPT_VARIABLE]: SKILL_SCRIPT_FILE, [ARTIFACT_SCRIPT_VARIABLE]: ARTIFACT_SCRIPT_FILE, [STEP_SCRIPT_VARIABLE]: STEP_SCRIPT_FILE, [LOGIN_SCRIPT_VARIABLE]: LOGIN_SCRIPT_FILE, [RELAY_SCRIPT_VARIABLE]: RELAY_SCRIPT_FILE, [REQUIREMENTS_SCRIPT_VARIABLE]: REQUIREMENTS_SCRIPT_FILE, [HEAVY_SCRIPT_VARIABLE]: HEAVY_SCRIPT_FILE, ...skill.paths },
        // The vault's helper (issue #558), where the machine's client serves one and the machine is a box of a template:
        // the vault gives nothing to any other machine (issue #652). It asks with this job's proxy token.
        // git's way to GitHub, through the hopper (issue #652): the job holds no GitHub token.
        vars: {
          [PROXY_URL_VARIABLE]: url, ...(machine.client?.vault && machine.template ? { [SECRET_HELPER_VARIABLE]: machine.client.vault } : {}),
          // A GitLab job's git (issue #1448 part 3): to its user's GitLab, through the hopper too; the job holds no GitLab token.
          ...jobGitConfig(url, o.accounts.endpoints('github').url, gitlabOf(job), o.traceparent?.(job.id)), // the job's trace parent too (issue #1486 part 6)
        },
      };
    },
    githubProxy: {
      user,
      connection: {
        jobRepositories,
        api: (repo) => { const key = keyOf(repo); return !o.accounts.account(key) ? { problem: notMineAt(key, notConnected) } : api(key); },
        contribution,
        login: (repo) => o.accounts.account(keyOf(repo)),
      },
      reports,
      skillSource: (repo) => { const key = keyOf(repo); return !o.accounts.account(key) ? { problem: notMineAt(key, notMine) } : createSkillSourceGitHub({ apiUrl: o.accounts.endpoints(key).apiUrl, token: () => o.accounts.token(key), renew: (refused) => o.accounts.renew(key, refused) }); },
      scheduleSource: (repo) => { const key = keyOf(repo); return !o.accounts.account(key) ? { problem: notMineAt(key, notMine) } : createScheduleSourceGitHub({ apiUrl: o.accounts.endpoints(key).apiUrl, token: () => o.accounts.token(key), renew: (refused) => o.accounts.renew(key, refused) }); },
      reads: (repo) => {
        const key = keyOf(repo);
        return !o.accounts.account(key) ? { problem: notMineAt(key, notMine) } : createProxyApi({ apiUrl: o.accounts.endpoints(key).apiUrl, token: () => o.accounts.token(key), renew: (refused) => o.accounts.renew(key, refused), kind: 'per_job_read' });
      },
      infraPlans: createInfraPlans({
        store: o.store, clock: o.clock,
        head: async (repo, ref) => {
          const key = keyOf(repo);
          if (!o.accounts.account(key)) throw new Error(notMineAt(key, notConnected));
          return api(key).head(repo, ref);
        },
      }),
      outOfBand: createOutOfBandChanges({ store: o.store, clock: o.clock }), topology: createTopology({ store: o.store, clock: o.clock }),
      watches: createGitHubWatches({
        store: o.store, now: () => o.clock.now().toISOString(), log: (l) => o.logger.warn(l),
        github: () => (!o.accounts.account('github') ? { problem: o.accounts.ended('github') ?? notMine } : createWatchGitHub(mine())),
      }),
      componentWatchers: createComponentWatchers({
        watchers: [ledgerGitHubWatcher({
          ledger: o.store.workItems, now: () => o.clock.now().toISOString(),
          github: () => (!o.accounts.account('github') ? { problem: o.accounts.ended('github') ?? notMine } : createWatcherGitHub(mine())),
        }),
        // The hopper's own records (issue #1077, the next part): they need no GitHub connection, only their drift issues do.
        ledgerJobsWatcher({ ledger: o.store.workItems, jobs: o.store.jobs, now: () => o.clock.now().toISOString() }),
        lanesJobsWatcher({ lanes: o.store.lanes, jobs: o.store.jobs, now: () => o.clock.now().toISOString() }),
        intakeJobsWatcher({ sources: o.sources, jobs: o.store.jobs, now: () => o.clock.now().toISOString() }), cleanupJobsWatcher({ ledger: o.store.resourceLedger, jobs: o.store.jobs, now: () => o.clock.now().toISOString() }), // issue #2715
        // The integration branch's health, and the stack's (issue #1077, the last part).
        branchChecksWatcher({
          repositories: () => o.accounts.jobRepositories('github'), now: () => o.clock.now().toISOString(),
          github: () => (!o.accounts.account('github') ? { problem: o.accounts.ended('github') ?? notMine } : createWatcherGitHub(mine())),
        }),
        ...(o.stack ? [stackHealthWatcher({ read: o.stack, now: () => o.clock.now().toISOString() })] : [])],
        store: o.store, now: () => o.clock.now().toISOString(), log: (l) => o.logger.warn(l),
        github: () => (!o.accounts.account('github') ? { problem: o.accounts.ended('github') ?? notMine } : createWatcherGitHub(mine())),
      }),
      landingBatches: createLandingBatches({
        github: () => (!o.accounts.account('github') ? { problem: o.accounts.ended('github') ?? notMine } : createLandingBatchGitHub(mine())),
        login: () => o.accounts.account('github'),
        settings: () => o.store.settings.getLandingBatches() ?? DEFAULT_LANDING_BATCHES,
        events: () => o.store.events.recent(500, [...LANDING_BATCH_EVENT_TYPES]),
        record: (e) => { o.store.events.append(e); },
        // Every pull request a job named, followed or not (issue #1143): a job's pull request never stays on the tested branch.
        jobPullRequests: () => o.store.jobs.list({ namesPullRequest: true }).flatMap((j) => {
          const url = (j.sourceState?.source as { pullRequest?: unknown } | undefined)?.pullRequest;
          return typeof url === 'string' ? [url] : [];
        }),
        // The ledger's items the batch's pull requests did whole (issues #1175, #1356), whatever their job does now: the
        // batch run's merge closes their issues.
        closingIssues: (repo, merges) => batchClosingIssues(o.store.workItems.list({ state: [...MERGE_STANDS] }), repo, merges),
        now: () => o.clock.now(),
        log: (l) => o.logger.warn(l),
      }),
      ledgerFallbackRead: createLedgerFallbackRead({
        ledger: o.store.workItems, events: o.store.events, now: () => o.clock.now().toISOString(), log: (l) => o.logger.warn(l),
        github: () => (!o.accounts.account('github') ? { problem: o.accounts.ended('github') ?? notMine } : createWatcherGitHub(mine())),
      }),
      subIssueLinks: createSubIssueLinks({
        events: o.store.events, log: (l) => o.logger.warn(l),
        link: (repo) => {
          const key = keyOf(repo);
          return !o.accounts.account(key) ? { problem: notMineAt(key, notConnected) }
            : createSubIssueLinker({ apiUrl: o.accounts.endpoints(key).apiUrl, token: () => o.accounts.token(key), renew: (refused) => o.accounts.renew(key, refused) });
        },
      }),
      bugReports: createReportSender({ github: reports, reports: o.store.bugReports, now: () => o.clock.now().toISOString(), record: (e) => { o.store.events.append(e); }, log: (l) => o.logger.warn(l) }),
      repoChecks: createRepoChecks({
        github: () => { const login = o.accounts.account('github'); return login === undefined ? { problem: o.accounts.ended('github') ?? notMine } : { api: createRepoChecksGitHub(mine()), login }; },
        repos: () => o.store.settings.getJobRepositories('github'), reads: o.store.repoChecks,
        yolo: (repo) => yoloModeFor(o.store.settings.getYoloMode() ?? DEFAULT_YOLO_MODE, repo, everyJobRepository(o.store)),
        dismissed: () => o.store.settings.getRepoChecksDismissed(), setDismissed: (repos) => o.store.settings.setRepoChecksDismissed(repos),
        record: (e) => { o.store.events.append(e); }, now: () => o.clock.now().getTime(), log: (l) => o.logger.warn(l),
      }),
      pendingApprovals: createPendingApprovals({
        sources: () => o.accounts.keys().map((key) => (!o.accounts.account(key) ? { account: key, problem: notMineAt(key, notMine) } : {
          account: key, repos: o.accounts.jobRepositories(key),
          api: createApprovalsGitHub({ apiUrl: o.accounts.endpoints(key).apiUrl, token: () => o.accounts.token(key), renew: (refused: string) => o.accounts.renew(key, refused) }),
        })),
        now: () => o.clock.now().getTime(), log: (l) => o.logger.warn(l),
      }),
      actors: () => {
        const login = o.accounts.account('github');
        return login === undefined ? { problem: o.accounts.ended('github') ?? notMine } : { api: createActorsGitHub(mine()), login };
      },
      promotions: userPromotions({
        store: o.store, clock: o.clock, artifactUrl: o.artifactUrl, publicUrl: o.publicUrl,
        github: () => { const login = o.accounts.account('github'); return login === undefined ? { problem: o.accounts.ended('github') ?? notMine } : { api: createPromotionGitHub(mine()), login }; },
      }),
      issueDrafts: createIssueDrafts({
        drafter: o.issueDrafter ?? NO_DRAFTER, repos: jobRepositories, timeoutMs: ISSUE_DRAFT_TIMEOUT_MS, ...(o.hostname ? { hostname: o.hostname } : {}),
        github: (repo) => {
          const key = keyOf(repo);
          return o.accounts.account(key) === undefined
            ? { problem: notMineAt(key, notMine) }
            : { api: createPromotionGitHub({ apiUrl: o.accounts.endpoints(key).apiUrl, token: () => o.accounts.token(key), renew: (refused: string) => o.accounts.renew(key, refused) }) };
        },
        job: (id) => o.store.jobs.get(id), record: (e) => { o.store.events.append(e); },
      }),
      // A job's git acts with its own user's connection (issue #652), not the hopper's oldest user's.
      git: {
        user,
        jobRepositories,
        contribution,
        git: (at) => {
          const key = keyOf(at);
          const login = o.accounts.account(key);
          return login === undefined
            ? { problem: notMineAt(key, notMine) }
            : {
              url: o.accounts.endpoints(key).url, login,
              token: () => o.accounts.token(key),
              renew: (refused) => o.accounts.renew(key, refused),
              repo: (repo) => api(key).repo(repo),
              pullRequestBase: (repo, branch) => api(key).pullRequestBase(repo, branch),
            };
        },
        // The landing batch setting's, never GitHub's default branch (issues #1142, #1147).
        landingBranch: (repo) => { const cfg = o.store.settings.getLandingBatches()?.repos[repo.toLowerCase()]; return cfg && landingBranch(cfg); },
        ...(o.pushLines ? { shrinkGuard: shrinkGuard(o.pushLines) } : {}),
        // Direct push (issue #1806): the user's setting, read at each push; the check fetches with the account of the repository.
        directPush: (repo) => directPushFor(o.store.settings.getYoloMode() ?? DEFAULT_YOLO_MODE, repo),
        // A push kept as a saga (issue #1806): whether the broker recorded the push's event before a stop.
        recorded: (jobId, requestId) => o.store.events.recent(500, [...PUSH_EVENTS], jobId).some((e) => (e.data as { requestId?: unknown }).requestId === requestId),
        ...(o.fastForward ? { fastForward: ({ repo, ...push }: Parameters<CheckFastForward>[2] & { repo: string }) => o.fastForward!(repo, mirrorRemote(repo), push) } : {}),
        // Push requirements (issue #2555): the job's evaluations, else the commit's tree in the mirror and the hopper's defaults.
        pushed: summaries.pushed, // And, after a push, the summary in the branch's pull request (part 4).
        pushRequirements: pushRequirementsGate({ evaluations: (jobId) => o.store.events.recent(500, [PUSH_REQUIREMENTS_EVALUATED], jobId), defaults: () => o.store.settings.getPushRequirementDefaults(), job: (jobId) => o.store.jobs.get(jobId), override: (job) => pushRequirementOverride(job, (id) => o.store.directJobs.get(id)), ...(o.holdsRequirements ? { holds: o.holdsRequirements } : {}), remote: mirrorRemote }),
      },
    },
  };
}
