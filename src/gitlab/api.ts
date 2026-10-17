// What the hopper asks GitLab's REST API (v4) with a GitLab account's personal access token (issue #1448 part 2, design.md
// "A GitLab source"): who the token is and its confirmed emails, the projects it reaches, and a project's open issues with a
// label. Plain fetch: four GET calls, each paged by GitLab's `x-next-page` header. The token goes in the `PRIVATE-TOKEN`
// header only, never in a URL or a log line.
import type { GitLabIssue } from '../domain/gitlab-account.ts';

/** GitLab refused the token (401): it was revoked, it expired, or it never was one. The account ends; nothing else does. */
export class GitLabTokenRefused extends Error {}

/** Who a token is: its username and id, and its confirmed emails (undefined: GitLab did not show them). */
export interface GitLabIdentity { account: string; userId: number; verifiedEmails: string[] | undefined }

export interface GitLabApi {
  whoIs(): Promise<GitLabIdentity>;
  /** The projects the token's user is a member of, by path (`group/name`), in path order. */
  projects(): Promise<string[]>;
  /** The open issues of `project` that carry `label`. */
  issues(project: string, label: string): Promise<GitLabIssue[]>;
}

/** Pages read at most per list: 100 items each. */
const MAX_PAGES = 20;
const TIMEOUT_MS = 15_000;

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function createGitLabApi(o: { baseUrl: string; token: string; fetch?: typeof fetch }): GitLabApi {
  const get = o.fetch ?? fetch;
  const call = async (path: string): Promise<{ status: number; body: unknown; next?: string }> => {
    const res = await get(`${o.baseUrl}/api/v4${path}`, { headers: { 'PRIVATE-TOKEN': o.token, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401) throw new GitLabTokenRefused('GitLab refused the token (401): it was revoked, it expired, or it is not a token of this GitLab');
    const text = await res.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
    const next = res.headers.get('x-next-page') ?? '';
    return { status: res.status, body, ...(next ? { next } : {}) };
  };
  const ok = async (path: string): Promise<unknown> => {
    const r = await call(path);
    if (r.status >= 300) throw new Error(`GitLab answered ${r.status} to GET ${path.split('?')[0]}${r.body && typeof r.body === 'object' && 'message' in r.body ? `: ${JSON.stringify((r.body as Json).message)}` : ''}`);
    return r.body;
  };
  const pages = async (path: string): Promise<Json[]> => {
    const all: Json[] = [];
    let page: string | undefined = '1';
    for (let n = 0; page && n < MAX_PAGES; n++) {
      const r = await call(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (r.status >= 300) throw new Error(`GitLab answered ${r.status} to GET ${path.split('?')[0]}`);
      if (!Array.isArray(r.body)) throw new Error(`GitLab answered no list to GET ${path.split('?')[0]}`);
      all.push(...(r.body as Json[]));
      page = r.next;
    }
    return all;
  };
  return {
    async whoIs() {
      const me = await ok('/user') as Json | undefined;
      if (!me || typeof me.username !== 'string' || typeof me.id !== 'number') throw new Error('GitLab did not say who the token is');
      // The primary email is confirmed; the others count only once confirmed. A token that may not read them: not shown.
      const emails = await call('/user/emails').then((r) => (r.status < 300 && Array.isArray(r.body) ? r.body as Json[] : undefined), () => undefined);
      const verified = emails === undefined ? undefined : [
        ...(typeof me.email === 'string' && me.email ? [me.email] : []),
        ...emails.filter((e) => typeof e.email === 'string' && e.confirmed_at).map((e) => e.email as string),
      ];
      return { account: me.username, userId: me.id, verifiedEmails: verified };
    },
    async projects() {
      const list = await pages('/projects?membership=true&simple=true&archived=false&order_by=path&sort=asc');
      return list.map((p) => str(p.path_with_namespace)).filter(Boolean);
    },
    async issues(project, label) {
      const list = await pages(`/projects/${encodeURIComponent(project)}/issues?state=opened&labels=${encodeURIComponent(label)}`);
      return list.map((i) => ({
        project, iid: Number(i.iid), title: str(i.title), description: str(i.description), url: str(i.web_url),
        author: str((i.author as Json | undefined)?.username),
        assignees: Array.isArray(i.assignees) ? (i.assignees as Json[]).map((a) => str(a.username)).filter(Boolean) : [],
        labels: Array.isArray(i.labels) ? (i.labels as unknown[]).map(str).filter(Boolean) : [],
      }));
    },
  };
}
