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
 * email GitHub verified for it (issue #1380, the source email match); absent when GitHub did not show them. `avatarUrl`:
 * the account's picture, which hopper.io shows (issue #463).
 */
export interface AccountIdentity { subject: string; account: string; name?: string; email?: string; verifiedEmails?: string[]; avatarUrl?: string }

const github = (app: HopperApp, token: string) =>
  octokitRequest.defaults({ baseUrl: app.apiUrl, headers: { authorization: `token ${token}`, 'user-agent': 'hopper', 'x-github-api-version': '2022-11-28' } });

export async function whoIs(app: HopperApp, token: string): Promise<AccountIdentity> {
  const req = github(app, token);
  const u = (await req('GET /user')).data as { id: number; login: string; name?: string | null; avatar_url?: string | null };
  // The verified emails, and the primary one, when the app may read email addresses; without them the identity has none.
  const emails = await req('GET /user/emails').then((r) => (r.data as { email: string; primary: boolean; verified: boolean }[]).filter((e) => e.verified), () => undefined);
  const email = emails?.find((e) => e.primary)?.email;
  return {
    subject: String(u.id), account: u.login, ...(u.name ? { name: u.name } : {}), ...(email ? { email } : {}),
    ...(u.avatar_url ? { avatarUrl: u.avatar_url } : {}),
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

interface Installation { id: number; account?: { login?: string; avatar_url?: string | null } | null; html_url?: string; repository_selection?: string; permissions?: Record<string, string> }

const LEVELS = ['read', 'write', 'admin'];

/**
 * An installation's **permission request** (issue #1378): the permissions the app asks for, at their level, that the
 * installation does not grant at that level or higher. GitHub asks the installation's owner to accept them when the app's
 * owner adds them to the app; the hopper cannot ask by itself. Empty: the owner accepted every one.
 */
export function permissionRequest(asked: Record<string, string>, granted: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(asked).filter(([p, level]) => LEVELS.indexOf(granted[p] ?? '') < LEVELS.indexOf(level)));
}

/**
 * The installations of the app the token's user can see, each with the repositories it reaches there that the user can
 * see, and its permission request: what the app asks for (`GET /apps/{slug}`) that it does not grant yet. Without the
 * app's slug, or when GitHub does not answer the app, no installation says its permission request. Each GET through
 * `answers`, with the ETag kept from the read before.
 */
export async function installations(app: HopperApp, token: string, answers: ConditionalAnswers): Promise<AppInstallation[]> {
  const req = makeRequest(app.apiUrl) as unknown as Get;
  const headers = { authorization: `token ${token}` };
  const get = (route: string, params: Record<string, unknown>) => answers.get<unknown>(req, route, { ...params, headers });
  const found = await all((page) => get('GET /user/installations', { per_page: PER_PAGE, page }),
    (d) => (d as { installations: Installation[] }).installations);
  const asked = app.slug
    ? await get('GET /apps/{app_slug}', { app_slug: app.slug }).then((d) => (d as { permissions?: Record<string, string> }).permissions, () => undefined)
    : undefined;
  return Promise.all(found.filter((i) => i.account?.login).map(async (i) => {
    const repositories = await all((page) => get('GET /user/installations/{installation_id}/repositories', { installation_id: i.id, per_page: PER_PAGE, page }),
      (d) => (d as { repositories: { full_name: string }[] }).repositories.map((r) => r.full_name));
    return {
      account: i.account!.login!, ...(i.account!.avatar_url ? { avatarUrl: i.account!.avatar_url } : {}), repositorySelection: i.repository_selection === 'selected' ? 'selected' : 'all', repositories,
      ...(i.html_url ? { settingsUrl: i.html_url } : {}),
      ...(i.permissions ? { permissions: i.permissions } : {}),
      ...(asked ? { permissionRequest: permissionRequest(asked, i.permissions ?? {}) } : {}),
    } satisfies AppInstallation;
  }));
}

/**
 * The repositories a personal access token reaches (issue #1380): GitHub's list for the token's user, every page, one entry
 * per owner with the owner's picture (issue #2774), `selected` (the token, not an app, decides what it reaches). Each GET
 * through `answers`, as `installations`.
 */
export async function tokenRepositories(app: HopperApp, token: string, answers: ConditionalAnswers): Promise<AppInstallation[]> {
  const req = makeRequest(app.apiUrl) as unknown as Get;
  const headers = { authorization: `token ${token}` };
  const found = await all((page) => answers.get<unknown>(req, 'GET /user/repos', { per_page: PER_PAGE, page, headers }),
    (d) => d as { full_name: string; owner?: { avatar_url?: string | null } | null }[]);
  const by = new Map<string, string[]>();
  const avatars = new Map<string, string>();
  for (const r of found) {
    const owner = r.full_name.split('/')[0]!;
    by.set(owner, [...(by.get(owner) ?? []), r.full_name]);
    if (r.owner?.avatar_url) avatars.set(owner, r.owner.avatar_url);
  }
  return [...by.keys()].sort().map((account) => ({
    account, ...(avatars.has(account) ? { avatarUrl: avatars.get(account)! } : {}), repositorySelection: 'selected', repositories: by.get(account)!.sort(),
  }));
}
