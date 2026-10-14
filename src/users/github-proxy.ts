// One user's side of the GitHub proxy (issue #563, design.md "GitHub through the hopper"): what each of their jobs
// asks the hopper with — its proxy token under this user's link key, `hopper-gh`, the hopper's URL as its machine
// reaches it, and git's way to the hopper (issue #652) —, the check of a token a job shows, and this user's GitHub
// connection, which the hopper acts with for every job when this is its oldest user, and for this user's own jobs' git.
// The shrink guard (issue #1096) of their jobs' pushes: the push's lines from the user's mirror, with their own connection,
// judged at the percent of their settings, read at each push.
import { createInfraPlans, type InfraPlans } from '../infra-plans/service.ts';
import { createOutOfBandChanges, type OutOfBandChanges } from '../infra-plans/out-of-band.ts';
import type { Clock, ConnectedAccountTokens, JobProxyCredentials, UserStore } from '../domain/ports.ts';
import { DEFAULT_SHRINK_GUARD, shrinkReason, shrunkFiles } from '../domain/shrink-guard.ts';
import type { CountPushLines } from '../git-mirror/push-lines.ts';
import { DEFAULT_CONTRIBUTION, type Job, type MachineSnapshot, type SourceStatus, type User } from '../domain/types.ts';
import { createReportGitHub, createReportSender, type ReportGitHub, type ReportSender } from '../bug-reports/index.ts';
import { createRepoChecksGitHub, type RepoChecksGitHub } from '../repo-checks/index.ts';
import { createActorsGitHub, type ActorsGitHub } from '../intake-actors/index.ts';
import { createPromotionGitHub } from '../promotions/github.ts';
import { userPromotions, type Promotions } from '../promotions/service.ts';
import { createGitHubWatches, createWatchGitHub, type GitHubWatches } from '../github-watch/index.ts';
import {
  branchChecksWatcher, createComponentWatchers, createWatcherGitHub, intakeJobsWatcher, lanesJobsWatcher, ledgerGitHubWatcher, ledgerJobsWatcher, stackHealthWatcher, type ComponentWatchers,
} from '../component-watchers/index.ts';
import type { StackResources } from '../domain/stack-resources.ts';
import { createLandingBatchGitHub } from '../landing-batches/github.ts';
import { createLandingBatches, type LandingBatches } from '../landing-batches/runner.ts';
import { DEFAULT_LANDING_BATCHES, LANDING_BATCH_EVENT_TYPES } from '../domain/landing-batches.ts';
import { createLedgerFallbackRead, type LedgerFallbackRead } from '../work-items/fallback-read.ts';
import { SECRET_HELPER_VARIABLE } from '../client/vault.ts';
import { SKILL_SCRIPT, SKILL_SCRIPT_FILE, SKILL_SCRIPT_VARIABLE } from '../skills/script.ts';
import { ARTIFACT_SCRIPT, ARTIFACT_SCRIPT_FILE, ARTIFACT_SCRIPT_VARIABLE } from '../artifacts/script.ts';
import { STEP_SCRIPT, STEP_SCRIPT_FILE, STEP_SCRIPT_VARIABLE } from '../windows-steps/script.ts';
import {
  createProxyApi, holdsProxyToken, jobGitConfig, type GitUser, proxyToken, PROXY_SCRIPT, PROXY_SCRIPT_FILE, PROXY_SCRIPT_VARIABLE, PROXY_TOKEN_FILE, PROXY_TOKEN_VARIABLE,
  PROXY_URL_VARIABLE, type ProxyConnection, type ProxyUser,
} from '../github-proxy/index.ts';

/** A user's side of the GitHub proxy: their jobs as askers, their GitHub connection as the hopper's, and as their jobs' git's. */
export interface UserGitHubProxy {
  user: ProxyUser;
  connection: ProxyConnection;
  git: GitUser;
  /** Report a bug (issue #694): this user's own GitHub connection, so a report is filed as this user; or why there is none. */
  reports(): ReportGitHub | { problem: string };
  /** Repositories with no checks (issue #677): this user's own GitHub connection and its login, or why there is none. */
  repoChecks(): { api: RepoChecksGitHub; login: string } | { problem: string };
  /** The trusted actor picker (issue #930): this user's own GitHub connection and its login, or why there is none. */
  actors(): { api: ActorsGitHub; login: string } | { problem: string };
  /** Promote to GitHub (issue #946): this user's direct jobs posted with this user's own GitHub connection, never a job's. */
  promotions: Promotions;
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
  /** The out-of-band changes (issue #871): what this user's jobs' checks report, a person's marks, the controller identities. */
  outOfBand: OutOfBandChanges;
}

export interface UserGitHubProxyOptions {
  user: User;
  store: UserStore;
  clock: Clock;
  logger: { warn(line: string): void };
  /** The private half of the hopper's link key for this user (issue #308): the key its jobs' tokens are derived under. */
  linkPrivateKey: string;
  accounts: ConnectedAccountTokens;
  /** The hopper's URL as a job on `machine` reaches it; undefined: it cannot, and its jobs get no proxy. */
  url(machine: MachineSnapshot): string | undefined;
  /** An artifact's stable URL, and the hopper's public URL (issue #946: a promotion's links are made only on it). */
  artifactUrl(id: string): string;
  publicUrl(): string | undefined;
  /** The job sources' statuses, each with its last intake (issue #1077: the intake-vs-jobs watcher reads them). */
  sources(): readonly SourceStatus[];
  /** The stack resources (issue #1077: the stack-health watcher reads them), given to the oldest user only; absent: none. */
  stack?: () => Promise<StackResources>;
  /** A push's lines, counted in the user's mirrors of the job repositories (issue #1096); absent: no shrink guard. */
  pushLines?: CountPushLines;
}

export function createUserGitHubProxy(o: UserGitHubProxyOptions): { githubProxy: UserGitHubProxy; jobProxy(job: Job, machine: MachineSnapshot): JobProxyCredentials | undefined } {
  const notConnected = 'the hopper\'s GitHub is not connected: its admin connects it in Sources → Connect GitHub';
  const api = () => createProxyApi({
    apiUrl: o.accounts.endpoints('github').apiUrl,
    token: () => o.accounts.token('github'),
    renew: (refused) => o.accounts.renew('github', refused),
  });
  const notMine = 'your GitHub is not connected: connect it in Sources → Connect GitHub';
  /** This user's own connection, for what they do themselves: Report a bug, the Add PR checks job. */
  const mine = () => ({ apiUrl: o.accounts.endpoints('github').apiUrl, token: () => o.accounts.token('github'), renew: (refused: string) => o.accounts.renew('github', refused) });
  const reports = (): ReportGitHub | { problem: string } => (!o.accounts.account('github')
    ? { problem: o.accounts.ended('github') ?? notMine }
    : createReportGitHub(mine()));
  /** This user's Contribution (issue #429), read at each request: a change applies without a restart. */
  const contribution = () => (o.store.settings.getContribution() ?? DEFAULT_CONTRIBUTION).on;
  /**
   * The shrink guard (issue #1096): a push's lines from the mirror, fetched with this user's own connection, judged at the
   * percent of the user's settings. Git cannot say: the push goes on, as it did before the guard.
   */
  const shrinkGuard = (pushLines: CountPushLines): NonNullable<GitUser['shrinkGuard']> => async (push) => {
    const remote = async () => ({ url: `${o.accounts.endpoints('github').url.replace(/\/+$/, '')}/${push.repo}.git`, token: await o.accounts.token('github') });
    const lines = await pushLines(push.repo, remote, push);
    if (!lines?.brings) return { ok: true };
    const shrunk = shrunkFiles(lines.files, (o.store.settings.getShrinkGuard() ?? DEFAULT_SHRINK_GUARD).percent);
    return shrunk.length === 0 ? { ok: true } : { ok: false, shrunk, reason: shrinkReason(shrunk, push.base) };
  };
  const user: ProxyUser = {
    id: o.user.id,
    holds: (parts) => parts.userId === o.user.id && holdsProxyToken(o.linkPrivateKey, parts),
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
  };
  return {
    jobProxy(job, machine) {
      const url = o.url(machine);
      if (!url) return undefined;
      return {
        url,
        // `hopper-skill` (issue #582) asks with the same token: what the hopper can set up for this box; `hopper-artifact`
        // (issue #624) puts what the job makes for a person to see; `hopper-step` (issue #731) runs one step on a Windows host.
        files: { [PROXY_TOKEN_FILE]: proxyToken(o.linkPrivateKey, o.user.id, job.id), [PROXY_SCRIPT_FILE]: PROXY_SCRIPT, [SKILL_SCRIPT_FILE]: SKILL_SCRIPT, [ARTIFACT_SCRIPT_FILE]: ARTIFACT_SCRIPT, [STEP_SCRIPT_FILE]: STEP_SCRIPT },
        paths: { [PROXY_TOKEN_VARIABLE]: PROXY_TOKEN_FILE, [PROXY_SCRIPT_VARIABLE]: PROXY_SCRIPT_FILE, [SKILL_SCRIPT_VARIABLE]: SKILL_SCRIPT_FILE, [ARTIFACT_SCRIPT_VARIABLE]: ARTIFACT_SCRIPT_FILE, [STEP_SCRIPT_VARIABLE]: STEP_SCRIPT_FILE },
        // The vault's helper (issue #558), where the machine's client serves one and the machine is a box of a template:
        // the vault gives nothing to any other machine (issue #652). It asks with this job's proxy token.
        // git's way to GitHub, through the hopper (issue #652): the job holds no GitHub token.
        vars: {
          [PROXY_URL_VARIABLE]: url, ...(machine.client?.vault && machine.template ? { [SECRET_HELPER_VARIABLE]: machine.client.vault } : {}),
          ...jobGitConfig(url, o.accounts.endpoints('github').url),
        },
      };
    },
    githubProxy: {
      user,
      connection: {
        jobRepositories: () => o.accounts.jobRepositories('github'),
        api: () => (!o.accounts.account('github') ? { problem: o.accounts.ended('github') ?? notConnected } : api()),
        contribution,
        login: () => o.accounts.account('github'),
      },
      reports,
      infraPlans: createInfraPlans({
        store: o.store, clock: o.clock,
        head: async (repo, ref) => {
          if (!o.accounts.account('github')) throw new Error(o.accounts.ended('github') ?? notConnected);
          return api().head(repo, ref);
        },
      }),
      outOfBand: createOutOfBandChanges({ store: o.store, clock: o.clock }),
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
        intakeJobsWatcher({ sources: o.sources, jobs: o.store.jobs, now: () => o.clock.now().toISOString() }),
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
        jobPullRequests: () => o.store.jobs.list({ followed: true }).flatMap((j) => {
          const url = (j.sourceState?.source as { pullRequest?: unknown } | undefined)?.pullRequest;
          return typeof url === 'string' ? [url] : [];
        }),
        now: () => o.clock.now(),
        log: (l) => o.logger.warn(l),
      }),
      ledgerFallbackRead: createLedgerFallbackRead({
        ledger: o.store.workItems, events: o.store.events, now: () => o.clock.now().toISOString(), log: (l) => o.logger.warn(l),
        github: () => (!o.accounts.account('github') ? { problem: o.accounts.ended('github') ?? notMine } : createWatcherGitHub(mine())),
      }),
      bugReports: createReportSender({ github: reports, reports: o.store.bugReports, now: () => o.clock.now().toISOString(), record: (e) => { o.store.events.append(e); }, log: (l) => o.logger.warn(l) }),
      repoChecks: () => {
        const login = o.accounts.account('github');
        return login === undefined ? { problem: o.accounts.ended('github') ?? notMine } : { api: createRepoChecksGitHub(mine()), login };
      },
      actors: () => {
        const login = o.accounts.account('github');
        return login === undefined ? { problem: o.accounts.ended('github') ?? notMine } : { api: createActorsGitHub(mine()), login };
      },
      promotions: userPromotions({
        store: o.store, clock: o.clock, artifactUrl: o.artifactUrl, publicUrl: o.publicUrl,
        github: () => { const login = o.accounts.account('github'); return login === undefined ? { problem: o.accounts.ended('github') ?? notMine } : { api: createPromotionGitHub(mine()), login }; },
      }),
      // A job's git acts with its own user's connection (issue #652), not the hopper's oldest user's.
      git: {
        user,
        jobRepositories: () => o.accounts.jobRepositories('github'),
        contribution,
        git: () => {
          const login = o.accounts.account('github');
          return login === undefined
            ? { problem: o.accounts.ended('github') ?? notMine }
            : {
              url: o.accounts.endpoints('github').url, login,
              token: () => o.accounts.token('github'),
              renew: (refused) => o.accounts.renew('github', refused),
              repo: (repo) => api().repo(repo),
            };
        },
        ...(o.pushLines ? { shrinkGuard: shrinkGuard(o.pushLines) } : {}),
      },
    },
  };
}
