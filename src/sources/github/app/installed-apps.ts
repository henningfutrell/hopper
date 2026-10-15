// The GitHub Apps installed on organizations (issue #1243, design.md "Pick an installed GitHub App"): what the app source's
// setup card offers to pick, so a person need not look up an app's id and slug on GitHub. Read with the person's own GitHub
// connection, GET /orgs/{org}/installations, through the shared rate limiter. GitHub lists them only to an owner of the
// organization, and only when the token may read the organization's Administration: an organization it refuses is named
// with why, never dropped in silence. Read on a person's ask only; nothing is kept.
import type { InstalledApp, InstalledAppsView } from '../../../domain/types.ts';
import { makeRequest, type Request } from './http.ts';

const PER_PAGE = 100;

interface Installation { app_id: number; app_slug: string; html_url?: string }

/** Why GitHub would not list an organization's apps, in plain words. */
function refusal(err: unknown): string {
  const status = (err as { status?: unknown }).status;
  if (status === 403 || status === 404) {
    return `GitHub answered ${status}: only an owner of the organization can list its apps, and the hopper's app needs the organization's Administration permission (read). Set the app's id and slug by hand.`;
  }
  return `GitHub could not list its apps: ${(err as Error).message}`;
}

/** The apps installed on each of `accounts` (organizations), each asked with `token`. */
export async function listInstalledApps(o: { apiUrl: string; token: string; accounts: readonly string[]; request?: Request }): Promise<Omit<InstalledAppsView, 'notConnected'>> {
  const req = o.request ?? makeRequest(o.apiUrl);
  const read = async (org: string): Promise<InstalledApp[]> => {
    const out: InstalledApp[] = [];
    for (let page = 1; ; page++) {
      const r = await req('GET /orgs/{org}/installations', { org, per_page: PER_PAGE, page, headers: { authorization: `token ${o.token}` } });
      const items = (r.data as { installations: Installation[] }).installations;
      out.push(...items.map((i) => ({ account: org, appId: i.app_id, slug: i.app_slug, ...(i.html_url ? { settingsUrl: i.html_url } : {}) })));
      if (items.length < PER_PAGE) return out;
    }
  };
  const results = await Promise.all(o.accounts.map(async (account) => {
    try { return { account, apps: await read(account) }; } catch (e) { return { account, error: refusal(e) }; }
  }));
  return {
    apps: results.flatMap((r) => r.apps ?? []),
    refused: results.flatMap((r) => (r.error ? [{ account: r.account, error: r.error }] : [])),
  };
}
