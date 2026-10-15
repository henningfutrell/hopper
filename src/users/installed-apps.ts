// The GitHub Apps installed on the organizations a user's GitHub connection knows (issue #1243, design.md "Pick an installed
// GitHub App"): the accounts the hopper's app is installed on, as last read, and the owners of the job repositories — not
// the connected account's own login, which is no organization. Asked with the connection's token, on a person's ask.
import type { ConnectedAccounts, ConnectedAccountTokens } from '../domain/ports.ts';
import type { InstalledAppsView } from '../domain/types.ts';
import { notConnected } from '../connected-accounts/service.ts';
import { listInstalledApps } from '../sources/index.ts';

export interface InstalledApps { list(): Promise<InstalledAppsView> }

export function userInstalledApps(accounts: Pick<ConnectedAccounts, 'status'> & Pick<ConnectedAccountTokens, 'account' | 'token' | 'endpoints' | 'jobRepositories'>): InstalledApps {
  return {
    async list() {
      const login = accounts.account('github');
      if (!login) return { apps: [], refused: [], notConnected: notConnected('github') };
      const status = (await accounts.status()).find((s) => s.provider === 'github');
      const installedOn = status?.state === 'connected' ? (status.installations ?? []).map((i) => i.account) : [];
      const owners = accounts.jobRepositories('github').map((r) => r.split('/')[0]!);
      const orgs = [...new Set([...installedOn, ...owners])].filter((a) => a && a.toLowerCase() !== login.toLowerCase()).sort();
      let token: string;
      try { token = await accounts.token('github'); } catch (e) { return { apps: [], refused: [], notConnected: (e as Error).message }; } // its sign-in ended
      return listInstalledApps({ apiUrl: accounts.endpoints('github').apiUrl, token, accounts: orgs });
    },
  };
}
