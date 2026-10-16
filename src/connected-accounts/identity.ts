// Who a token of the hopper's GitHub App belongs to, and where the app is installed (issue #214):
// GitHub's own answer, through @octokit/request as the sources use it. The identity signs a person in
// and names their connected account. Where the app is installed is read through the shared rate limiter, each GET
// conditional (issue #1250, conditional.ts): an unchanged answer is a 304, which costs no call.
import { request as octokitRequest } from '@octokit/request';
import type { AppInstallation } from '../domain/types.ts';
import type { ConditionalAnswers, Get } from '../repo-checks/conditional.ts';
import { makeRequest } from '../sources/github/http/http.ts';
import type { HopperApp } from './hopper-app.ts';

/**
 * The account a token belongs to. `subject`: GitHub's stable numeric id; `account`: the login. `verifiedEmails`: every
 * email GitHub verified for it (issue #1380, the source email match); absent when GitHub did not show them.
 */
export interface AccountIdentity { subject: string; account: string; name?: string; email?: string; verifiedEmails?: string[] }

const github = (app: HopperApp, token: string) =>
  octokitRequest.defaults({ baseUrl: app.apiUrl, headers: { authorization: `token ${token}`, 'user-agent': 'hopper', 'x-github-api-version': '2022-11-28' } });

export async function whoIs(app: HopperApp, token: string): Promise<AccountIdentity> {
  const req = github(app, token);
  const u = (await req('GET /user')).data as { id: number; login: string; name?: string | null };
  // The verified emails, and the primary one, when the app may read email addresses; without them the identity has none.
  const emails = await req('GET /user/emails').then((r) => (r.data as { email: string; primary: boolean; verified: boolean }[]).filter((e) => e.verified), () => undefined);
  const email = emails?.find((e) => e.primary)?.email;
  return {
    subject: String(u.id), account: u.login, ...(u.name ? { name: u.name } : {}), ...(email ? { email } : {}),
    ...(emails ? { verifiedEmails: emails.map((e) => e.email) } : {}),
  };
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

interface Installation { id: number; account?: { login?: string } | null; html_url?: string; repository_selection?: string; permissions?: Record<string, string> }

/**
 * The installations of the app the token's user can see, each with the repositories it reaches there that the user can
 * see. Each GET through `answers`, with the ETag kept from the read before.
 */
export async function installations(app: HopperApp, token: string, answers: ConditionalAnswers): Promise<AppInstallation[]> {
  const req = makeRequest(app.apiUrl) as unknown as Get;
  const headers = { authorization: `token ${token}` };
  const get = (route: string, params: Record<string, unknown>) => answers.get<unknown>(req, route, { ...params, headers });
  const found = await all((page) => get('GET /user/installations', { per_page: PER_PAGE, page }),
    (d) => (d as { installations: Installation[] }).installations);
  return Promise.all(found.filter((i) => i.account?.login).map(async (i) => {
    const repositories = await all((page) => get('GET /user/installations/{installation_id}/repositories', { installation_id: i.id, per_page: PER_PAGE, page }),
      (d) => (d as { repositories: { full_name: string }[] }).repositories.map((r) => r.full_name));
    return {
      account: i.account!.login!, repositorySelection: i.repository_selection === 'selected' ? 'selected' : 'all', repositories,
      ...(i.html_url ? { settingsUrl: i.html_url } : {}),
      ...(i.permissions ? { permissions: i.permissions } : {}),
    } satisfies AppInstallation;
  }));
}

/**
 * The repositories a personal access token reaches (issue #1380): GitHub's list for the token's user, every page, one entry
 * per owner, `selected` (the token, not an app, decides what it reaches). Each GET through `answers`, as `installations`.
 */
export async function tokenRepositories(app: HopperApp, token: string, answers: ConditionalAnswers): Promise<AppInstallation[]> {
  const req = makeRequest(app.apiUrl) as unknown as Get;
  const headers = { authorization: `token ${token}` };
  const names = await all((page) => answers.get<unknown>(req, 'GET /user/repos', { per_page: PER_PAGE, page, headers }),
    (d) => (d as { full_name: string }[]).map((r) => r.full_name));
  const by = new Map<string, string[]>();
  for (const name of names) {
    const owner = name.split('/')[0]!;
    by.set(owner, [...(by.get(owner) ?? []), name]);
  }
  return [...by.keys()].sort().map((account) => ({ account, repositorySelection: 'selected', repositories: by.get(account)!.sort() }));
}
