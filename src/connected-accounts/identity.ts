// Who a token of the hopper's GitHub App belongs to, and where the app is installed (issue #214):
// GitHub's own answer, through @octokit/request as the sources use it. The identity signs a person in
// and names their connected account.
import { request as octokitRequest } from '@octokit/request';
import type { HopperApp } from './hopper-app.ts';

/** The account a token belongs to. `subject`: GitHub's stable numeric id; `account`: the login. */
export interface AccountIdentity { subject: string; account: string; name?: string; email?: string }

const github = (app: HopperApp, token: string) =>
  octokitRequest.defaults({ baseUrl: app.apiUrl, headers: { authorization: `token ${token}`, 'user-agent': 'hopper', 'x-github-api-version': '2022-11-28' } });

export async function whoIs(app: HopperApp, token: string): Promise<AccountIdentity> {
  const req = github(app, token);
  const u = (await req('GET /user')).data as { id: number; login: string; name?: string | null };
  // A primary verified email, when the app may read email addresses; without it the identity has none.
  const email = await req('GET /user/emails').then((r) => (r.data as { email: string; primary: boolean; verified: boolean }[]).find((e) => e.primary && e.verified)?.email, () => undefined);
  return { subject: String(u.id), account: u.login, ...(u.name ? { name: u.name } : {}), ...(email ? { email } : {}) };
}

/** The accounts the app is installed on that the token's user can see. */
export async function installations(app: HopperApp, token: string): Promise<string[]> {
  const r = await github(app, token)('GET /user/installations', { per_page: 100 });
  return (r.data as { installations: { account?: { login?: string } | null }[] }).installations.map((i) => i.account?.login ?? '').filter(Boolean);
}
