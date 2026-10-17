// The fake GitHub's apps installed on organizations (issue #1243), for test/support/fake-forges.ts: GET
// /orgs/{org}/installations, as the GitHub App source's setup card lists them to pick one; and the hopper's app itself
// (issue #1378): GET /apps/{slug}, the permissions it asks for of every installation.

/** What an installation of the shipped app grants, and what the app asks for, unless a test says otherwise. */
export const GRANTED: Record<string, string> = { contents: 'write', issues: 'write', metadata: 'read', pull_requests: 'write' };

export interface OrgAppsForge {
  /**
   * The apps installed on each organization, by organization; a number: GitHub refuses the list with that status (the person
   * is no owner, or the token lacks the organization's Administration). An organization not named answers 404.
   */
  orgApps?: Record<string, { id: number; slug: string }[] | number>;
  /** GitHub: the permissions the app asks for (GET /apps/{slug}); default: `GRANTED`. */
  appPermissions?: Record<string, string>;
  /** GitHub: what each installation grants (GET /user/installations), by account; an account not named here grants `GRANTED`. */
  installationPermissions?: Record<string, Record<string, string>>;
}

type Answer = { status: number; body?: unknown };

/** The answer to an organization's installations, or undefined when the request is no such read. */
export function orgAppsRoute(forge: OrgAppsForge | undefined, base: string, method: string, path: string, query: Record<string, string>): Answer | undefined {
  const app = /^\/apps\/([^/]+)$/.exec(path);
  if (method === 'GET' && app) return { status: 200, body: { slug: app[1], permissions: forge?.appPermissions ?? GRANTED } };
  const m = /^\/orgs\/([^/]+)\/installations$/.exec(path);
  if (method !== 'GET' || !m) return undefined;
  const org = m[1]!;
  const apps = forge?.orgApps?.[org];
  if (apps === undefined) return { status: 404, body: { message: 'Not Found' } };
  if (typeof apps === 'number') return { status: apps, body: { message: 'Resource not accessible by integration' } };
  const per = Number(query.per_page ?? 30);
  const page = Number(query.page ?? 1);
  const all = apps.map((a, i) => ({ id: 100 + i, app_id: a.id, app_slug: a.slug, account: { login: org }, html_url: `${base}/organizations/${org}/settings/installations/${100 + i}` }));
  return { status: 200, body: { total_count: all.length, installations: all.slice((page - 1) * per, page * per) } };
}
