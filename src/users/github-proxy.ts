// One user's side of the GitHub proxy (issue #563, design.md "GitHub through the hopper"): what each of their jobs
// asks the hopper with — its proxy token under this user's link key, `hopper-gh`, the hopper's URL as its machine
// reaches it, and git's way to the hopper (issue #652) —, the check of a token a job shows, and this user's GitHub
// connection, which the hopper acts with for every job when this is its oldest user, and for this user's own jobs' git.
import { createInfraPlans, type InfraPlans } from '../infra-plans/service.ts';
import { createOutOfBandChanges, type OutOfBandChanges } from '../infra-plans/out-of-band.ts';
import type { Clock, ConnectedAccountTokens, JobProxyCredentials, UserStore } from '../domain/ports.ts';
import { DEFAULT_CONTRIBUTION, type Job, type MachineSnapshot, type User } from '../domain/types.ts';
import { createReportGitHub, createReportSender, type ReportGitHub, type ReportSender } from '../bug-reports/index.ts';
import { createRepoChecksGitHub, type RepoChecksGitHub } from '../repo-checks/index.ts';
import { createActorsGitHub, type ActorsGitHub } from '../intake-actors/index.ts';
import { createGitHubWatches, createWatchGitHub, type GitHubWatches } from '../github-watch/index.ts';
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
  /** Report a bug's kept reports sent later, and the filed ones' states read (issue #694); its loop runs with the user's runtime. */
  bugReports: ReportSender;
  /** The GitHub watches of this user's pointed jobs (issue #427), with this user's own connection; they poll with the user's runtime. */
  watches: GitHubWatches;
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
  const user: ProxyUser = {
    id: o.user.id,
    holds: (parts) => parts.userId === o.user.id && holdsProxyToken(o.linkPrivateKey, parts),
    job: (id) => o.store.jobs.get(id),
    machineOf: (job) => o.store.lanes.list().find((l) => l.id === job.laneId)?.machineId,
    record: (event) => { o.store.events.append(event); },
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
      bugReports: createReportSender({ github: reports, reports: o.store.bugReports, now: () => o.clock.now().toISOString(), record: (e) => { o.store.events.append(e); }, log: (l) => o.logger.warn(l) }),
      repoChecks: () => {
        const login = o.accounts.account('github');
        return login === undefined ? { problem: o.accounts.ended('github') ?? notMine } : { api: createRepoChecksGitHub(mine()), login };
      },
      actors: () => {
        const login = o.accounts.account('github');
        return login === undefined ? { problem: o.accounts.ended('github') ?? notMine } : { api: createActorsGitHub(mine()), login };
      },
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
      },
    },
  };
}
