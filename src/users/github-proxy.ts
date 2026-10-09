// One user's side of the GitHub proxy (issue #563, design.md "GitHub through the hopper"): what each of their jobs
// asks the hopper with — its proxy token under this user's link key, `hopper-gh`, the hopper's URL as its machine
// reaches it —, the check of a token a job shows, and this user's GitHub connection, which the hopper acts with
// for every job when this is its oldest user.
import type { ConnectedAccountTokens, JobProxyCredentials, UserStore } from '../domain/ports.ts';
import type { Job, MachineSnapshot, User } from '../domain/types.ts';
import { SECRET_HELPER_VARIABLE } from '../client/vault.ts';
import {
  createProxyApi, holdsProxyToken, proxyToken, PROXY_SCRIPT, PROXY_SCRIPT_FILE, PROXY_SCRIPT_VARIABLE, PROXY_TOKEN_FILE, PROXY_TOKEN_VARIABLE,
  PROXY_URL_VARIABLE, type ProxyConnection, type ProxyUser,
} from '../github-proxy/index.ts';

/** A user's side of the GitHub proxy: their jobs as askers, and their GitHub connection as the hopper's. */
export interface UserGitHubProxy {
  user: ProxyUser;
  connection: ProxyConnection;
}

export interface UserGitHubProxyOptions {
  user: User;
  store: UserStore;
  /** The private half of the hopper's link key for this user (issue #308): the key its jobs' tokens are derived under. */
  linkPrivateKey: string;
  accounts: ConnectedAccountTokens;
  /** The hopper's URL as a job on `machine` reaches it; undefined: it cannot, and its jobs get no proxy. */
  url(machine: MachineSnapshot): string | undefined;
}

export function createUserGitHubProxy(o: UserGitHubProxyOptions): { githubProxy: UserGitHubProxy; jobProxy(job: Job, machine: MachineSnapshot): JobProxyCredentials | undefined } {
  const notConnected = 'the hopper\'s GitHub is not connected: its admin connects it in Sources → Connect GitHub';
  return {
    jobProxy(job, machine) {
      const url = o.url(machine);
      if (!url) return undefined;
      return {
        files: { [PROXY_TOKEN_FILE]: proxyToken(o.linkPrivateKey, o.user.id, job.id), [PROXY_SCRIPT_FILE]: PROXY_SCRIPT },
        paths: { [PROXY_TOKEN_VARIABLE]: PROXY_TOKEN_FILE, [PROXY_SCRIPT_VARIABLE]: PROXY_SCRIPT_FILE },
        // The vault's helper (issue #558), where the machine's client serves one: it asks with this job's proxy token.
        vars: { [PROXY_URL_VARIABLE]: url, ...(machine.client?.vault ? { [SECRET_HELPER_VARIABLE]: machine.client.vault } : {}) },
      };
    },
    githubProxy: {
      user: {
        id: o.user.id,
        holds: (parts) => parts.userId === o.user.id && holdsProxyToken(o.linkPrivateKey, parts),
        job: (id) => o.store.jobs.get(id),
        machineOf: (job) => o.store.lanes.list().find((l) => l.id === job.laneId)?.machineId,
        record: (event) => { o.store.events.append(event); },
      },
      connection: {
        jobRepositories: () => o.accounts.jobRepositories('github'),
        api: () => (!o.accounts.account('github')
          ? { problem: o.accounts.ended('github') ?? notConnected }
          : createProxyApi({
            apiUrl: o.accounts.endpoints('github').apiUrl,
            token: () => o.accounts.token('github'),
            renew: (refused) => o.accounts.renew('github', refused),
          })),
      },
    },
  };
}
