// Who a token of the hopper's GitHub App belongs to, and where the app is installed (issue #214):
// GitHub's own answer, through @octokit/request as the sources use it. The identity signs a person in
// and names their connected account.
import { request as octokitRequest } from '@octokit/request';
import type { AppInstallation } from '../domain/types.ts';
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

const PER_PAGE = 100;

/** Every page of a GitHub list: `pick` reads one page's items. */
async function all<T>(get: (page: number) => Promise<unknown>, pick: (data: unknown) => T[]): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const items = pick(await get(page));
    out.push(...items);
    if (items.length < PER_PAGE) return out;
  }
}

interface Installation { id: number; account?: { login?: string } | null; html_url?: string; repository_selection?: string }

/** The installations of the app the token's user can see, each with the repositories it reaches there that the user can see. */
export async function installations(app: HopperApp, token: string): Promise<AppInstallation[]> {
  const req = github(app, token);
  const found = await all((page) => req('GET /user/installations', { per_page: PER_PAGE, page }).then((r) => r.data),
    (d) => (d as { installations: Installation[] }).installations);
  return Promise.all(found.filter((i) => i.account?.login).map(async (i) => {
    const repositories = await all((page) => req('GET /user/installations/{installation_id}/repositories', { installation_id: i.id, per_page: PER_PAGE, page }).then((r) => r.data),
      (d) => (d as { repositories: { full_name: string }[] }).repositories.map((r) => r.full_name));
    return {
      account: i.account!.login!, repositorySelection: i.repository_selection === 'selected' ? 'selected' : 'all', repositories,
      ...(i.html_url ? { settingsUrl: i.html_url } : {}),
    } satisfies AppInstallation;
  }));
}
