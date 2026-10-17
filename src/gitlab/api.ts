// What the hopper asks GitLab's REST API (v4) with a GitLab account's personal access token (issue #1448 part 2, design.md
// "A GitLab source"): who the token is and its confirmed emails, the projects it reaches, and a project's open issues with a
// label. For a job (part 3, "Jobs through GitLab"): a project's default branch, an issue's label events and notes (its
// origin), and the hopper's labels on an issue. For a job's merge request (issue #1642, "A GitLab job's merge request"): one
// issue, and the merge requests that close it, an open one with its head pipeline. Plain fetch; a list is paged by GitLab's `x-next-page` header. The token goes
// in the `PRIVATE-TOKEN` header only, never in a URL or a log line.
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
  /** A project's default branch; undefined: it has none (an empty project). */
  defaultBranch(project: string): Promise<string | undefined>;
  /** An issue's label events, oldest first: who added or removed which label. */
  labelEvents(project: string, iid: number): Promise<GitLabLabelEvent[]>;
  /** An issue's system notes, oldest first: what GitLab wrote of an assignment or an edit, and who did it. */
  systemNotes(project: string, iid: number): Promise<GitLabNote[]>;
  /** Adds and removes labels on an issue, in one edit; a label it has, or does not have, is left as it is. */
  editLabels(project: string, iid: number, change: { add: readonly string[]; remove: readonly string[] }): Promise<void>;
  /** One issue, with its state. */
  issue(project: string, iid: number): Promise<GitLabIssue & { state: 'opened' | 'closed' }>;
  /** The merge requests whose description closes the issue (GitLab's `closed_by`), each open one with its head pipeline. */
  closingMergeRequests(project: string, iid: number): Promise<GitLabMergeRequest[]>;
}

/**
 * A merge request as the hopper judges a GitLab job by (issue #1642). `pipeline`: its head pipeline's status (`success`,
 * `failed`, `running`, …), read only for an open one; absent: none, or not read.
 */
export interface GitLabMergeRequest {
  iid: number; url: string; state: 'opened' | 'closed' | 'merged' | 'locked';
  draft: boolean; conflicting: boolean; createdAt: string; mergedAt?: string; pipeline?: string;
}

/** Who added or removed a label of an issue. `userId` absent: GitLab did not say. */
export interface GitLabLabelEvent { action: 'add' | 'remove'; label: string; account: string; userId?: number }

/** A system note of an issue: GitLab's own line of what someone did. */
export interface GitLabNote { body: string; account: string; userId?: number }

/** GitLab answered 404 or 410: the project or the issue is not there for this token. */
export class GitLabNotFound extends Error {}

/** Pages read at most per list: 100 items each. */
const MAX_PAGES = 20;
const TIMEOUT_MS = 15_000;

type Json = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** `{ [key]: id }` when GitLab gave a user id; else nothing. */
const idOf = <K extends string>(key: K, v: unknown): { [P in K]?: number } => (typeof v === 'number' ? { [key]: v } as { [P in K]?: number } : {});

const issueOf = (project: string, i: Json): GitLabIssue => ({
  project, iid: Number(i.iid), title: str(i.title), description: str(i.description), url: str(i.web_url),
  author: str((i.author as Json | undefined)?.username), ...idOf('authorId', (i.author as Json | undefined)?.id),
  assignees: Array.isArray(i.assignees) ? (i.assignees as Json[]).map((a) => str(a.username)).filter(Boolean) : [],
  labels: Array.isArray(i.labels) ? (i.labels as unknown[]).map(str).filter(Boolean) : [],
});

const MR_STATES = ['opened', 'closed', 'merged', 'locked'] as const;
const mergeRequestOf = (m: Json): GitLabMergeRequest => ({
  iid: Number(m.iid), url: str(m.web_url), state: MR_STATES.find((s) => s === m.state) ?? 'closed',
  draft: m.draft === true || m.work_in_progress === true, conflicting: m.has_conflicts === true, createdAt: str(m.created_at),
  ...(typeof m.merged_at === 'string' && m.merged_at ? { mergedAt: m.merged_at } : {}),
});

export function createGitLabApi(o: { baseUrl: string; token: string; fetch?: typeof fetch }): GitLabApi {
  const get = o.fetch ?? fetch;
  const call = async (path: string, write?: { method: 'PUT'; body: Json }): Promise<{ status: number; body: unknown; next?: string }> => {
    const res = await get(`${o.baseUrl}/api/v4${path}`, {
      ...(write ? { method: write.method, body: JSON.stringify(write.body) } : {}),
      headers: { 'PRIVATE-TOKEN': o.token, accept: 'application/json', ...(write ? { 'content-type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) throw new GitLabTokenRefused('GitLab refused the token (401): it was revoked, it expired, or it is not a token of this GitLab');
    const text = await res.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
    const next = res.headers.get('x-next-page') ?? '';
    return { status: res.status, body, ...(next ? { next } : {}) };
  };
  const ok = async (path: string, write?: { method: 'PUT'; body: Json }): Promise<unknown> => {
    const r = await call(path, write);
    const said = `GitLab answered ${r.status} to ${write?.method ?? 'GET'} ${path.split('?')[0]}${r.body && typeof r.body === 'object' && 'message' in r.body ? `: ${JSON.stringify((r.body as Json).message)}` : ''}`;
    if (r.status === 404 || r.status === 410) throw new GitLabNotFound(said);
    if (r.status >= 300) throw new Error(said);
    return r.body;
  };
  const pages = async (path: string): Promise<Json[]> => {
    const all: Json[] = [];
    let page: string | undefined = '1';
    for (let n = 0; page && n < MAX_PAGES; n++) {
      const r = await call(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (r.status === 404 || r.status === 410) throw new GitLabNotFound(`GitLab answered ${r.status} to GET ${path.split('?')[0]}`);
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
      return list.map((i) => issueOf(project, i));
    },
    async defaultBranch(project) {
      const p = await ok(`/projects/${encodeURIComponent(project)}`) as Json | undefined;
      return typeof p?.default_branch === 'string' && p.default_branch ? p.default_branch : undefined;
    },
    async labelEvents(project, iid) {
      const list = await pages(`/projects/${encodeURIComponent(project)}/issues/${iid}/resource_label_events`);
      return list.flatMap((e) => {
        const label = str((e.label as Json | undefined)?.name), user = e.user as Json | undefined;
        return (e.action === 'add' || e.action === 'remove') && label ? [{ action: e.action, label, account: str(user?.username), ...idOf('userId', user?.id) }] : [];
      });
    },
    async systemNotes(project, iid) {
      const list = await pages(`/projects/${encodeURIComponent(project)}/issues/${iid}/notes?sort=asc&order_by=created_at`);
      return list.filter((n) => n.system === true).map((n) => {
        const author = n.author as Json | undefined;
        return { body: str(n.body), account: str(author?.username), ...idOf('userId', author?.id) };
      });
    },
    async editLabels(project, iid, change) {
      if (change.add.length === 0 && change.remove.length === 0) return;
      await ok(`/projects/${encodeURIComponent(project)}/issues/${iid}`, {
        method: 'PUT', body: { ...(change.add.length ? { add_labels: change.add.join(',') } : {}), ...(change.remove.length ? { remove_labels: change.remove.join(',') } : {}) },
      });
    },
    async issue(project, iid) {
      const i = await ok(`/projects/${encodeURIComponent(project)}/issues/${iid}`) as Json | undefined;
      if (!i || typeof i.iid !== 'number') throw new Error(`GitLab did not answer issue ${project}#${iid}`);
      return { ...issueOf(project, i), state: i.state === 'closed' ? 'closed' : 'opened' };
    },
    async closingMergeRequests(project, iid) {
      const at = `/projects/${encodeURIComponent(project)}`;
      const list = (await pages(`${at}/issues/${iid}/closed_by`)).map(mergeRequestOf);
      // GitLab's list leaves out the head pipeline: an open one's is read from the merge request itself.
      return Promise.all(list.map(async (m) => {
        if (m.state !== 'opened') return m;
        const one = await ok(`${at}/merge_requests/${m.iid}`) as Json | undefined;
        const status = str((one?.head_pipeline as Json | null | undefined)?.status);
        return { ...m, ...(one ? mergeRequestOf(one) : {}), ...(status ? { pipeline: status } : {}) };
      }));
    },
  };
}
