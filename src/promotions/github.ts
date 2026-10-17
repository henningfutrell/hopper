// Promote to GitHub's calls (issue #946), with the promoting person's own GitHub connection, never a job's: a repository's
// visibility, the issue a comment goes on, a new issue, an issue edited, its labels added, a comment and a comment
// edited; part 2: the promotion's own branch made from the default branch, and a file put on it (the contents API); the
// look-up for a promotion's post key (issue #1591). The
// same `@octokit/request` binding and token renewal as Report a bug (src/bug-reports/github.ts).
import { hasPostKey } from '../domain/post-key.ts';
import type { RepoVisibility } from '../domain/promotions.ts';
import { tokenCaller, type TokenSource } from '../github-proxy/index.ts';
import { makeRequest, splitRepo, statusOf } from '../sources/github/http/http.ts';

export interface PromotionGitHub {
  repo(repo: string): Promise<{ visibility: RepoVisibility; hasIssues: boolean; defaultBranch: string }>;
  /** Make the branch at the head of `from`, unless it is there. */
  branch(repo: string, name: string, from: string): Promise<void>;
  /** Put a file on a branch, made or replaced: the file's URL. */
  putFile(repo: string, f: { branch: string; path: string; message: string; content: Buffer }): Promise<{ url: string }>;
  /** An issue, or a pull request, by number: what a comment goes on. */
  issue(repo: string, number: number): Promise<{ number: number; url: string; state: 'open' | 'closed' }>;
  create(repo: string, issue: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }>;
  edit(repo: string, number: number, issue: { title: string; body: string }): Promise<{ number: number; url: string }>;
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
  comment(repo: string, number: number, body: string): Promise<{ id: number; url: string }>;
  editComment(repo: string, id: number, body: string): Promise<{ id: number; url: string }>;
  /**
   * The issue `creator` made, or the comment on issue `number`, whose text carries the post key `key`, made or changed
   * since `since` (issue #1591); undefined: none.
   */
  find(repo: string, key: string, where: { kind: 'issue'; creator: string } | { kind: 'comment'; number: number }, since: string): Promise<{ number: number; url: string; commentId?: number } | undefined>;
}

/** GitHub's refusal or failure, with its status when it gave one. */
export class PromotionGitHubError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'PromotionGitHubError';
    if (status !== undefined) this.status = status;
  }
}

export function createPromotionGitHub(o: { apiUrl: string } & TokenSource): PromotionGitHub {
  const req = makeRequest(o.apiUrl);
  const withToken = tokenCaller(o);
  const failed = (what: string) => (err: unknown): Error => {
    const e = err as { message?: unknown; response?: { data?: { message?: unknown } } };
    const message = typeof e.response?.data?.message === 'string' ? e.response.data.message : String(e.message ?? err);
    return new PromotionGitHubError(`GitHub answered ${statusOf(err) ?? 'no status'} to ${what}: ${message}`, statusOf(err));
  };
  const headers = (token: string) => ({ authorization: `token ${token}` });
  return {
    repo: (repo) => withToken(async (token) => {
      const d = (await req('GET /repos/{owner}/{repo}', { ...splitRepo(repo), headers: headers(token) })).data as { private?: boolean; visibility?: string; has_issues?: boolean; default_branch?: string };
      const visibility: RepoVisibility = d.visibility === 'internal' ? 'internal' : d.private === true || d.visibility === 'private' ? 'private' : 'public';
      return { visibility, hasIssues: d.has_issues !== false, defaultBranch: d.default_branch ?? 'main' };
    }, failed(`the repository ${repo}`)),
    branch: (repo, name, from) => withToken(async (token) => {
      const at = { ...splitRepo(repo), headers: headers(token) };
      const there = await req('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...at, ref: `heads/${name}` }).then(() => true, (e: unknown) => { if (statusOf(e) === 404) return false; throw e; });
      if (there) return;
      const head = (await req('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...at, ref: `heads/${from}` })).data as { object: { sha: string } };
      await req('POST /repos/{owner}/{repo}/git/refs', { ...at, ref: `refs/heads/${name}`, sha: head.object.sha });
    }, failed(`the branch ${name} of ${repo}`)),
    putFile: (repo, f) => withToken(async (token) => {
      const at = { ...splitRepo(repo), path: f.path, headers: headers(token) };
      const was = await req('GET /repos/{owner}/{repo}/contents/{path}', { ...at, ref: f.branch })
        .then((r) => (r.data as { sha?: string }).sha, (e: unknown) => { if (statusOf(e) === 404) return undefined; throw e; });
      const d = (await req('PUT /repos/{owner}/{repo}/contents/{path}', {
        ...at, branch: f.branch, message: f.message, content: f.content.toString('base64'), ...(was ? { sha: was } : {}),
      })).data as { content: { html_url: string } };
      return { url: d.content.html_url };
    }, failed(`${f.path} on ${repo}`)),
    issue: (repo, number) => withToken(async (token) => {
      const d = (await req('GET /repos/{owner}/{repo}/issues/{issue_number}', { ...splitRepo(repo), issue_number: number, headers: headers(token) })).data as { number: number; html_url: string; state: string };
      return { number: d.number, url: d.html_url, state: d.state === 'closed' ? 'closed' : 'open' };
    }, failed(`${repo}#${number}`)),
    create: (repo, issue) => withToken(async (token) => {
      const d = (await req('POST /repos/{owner}/{repo}/issues', { ...splitRepo(repo), ...issue, headers: headers(token) })).data as { number: number; html_url: string };
      return { number: d.number, url: d.html_url };
    }, failed(`a new issue on ${repo}`)),
    edit: (repo, number, issue) => withToken(async (token) => {
      const d = (await req('PATCH /repos/{owner}/{repo}/issues/{issue_number}', { ...splitRepo(repo), issue_number: number, ...issue, headers: headers(token) })).data as { number: number; html_url: string };
      return { number: d.number, url: d.html_url };
    }, failed(`the edit of ${repo}#${number}`)),
    addLabels: (repo, number, labels) => withToken(async (token) => {
      await req('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', { ...splitRepo(repo), issue_number: number, labels, headers: headers(token) });
    }, failed(`the labels of ${repo}#${number}`)),
    comment: (repo, number, body) => withToken(async (token) => {
      const d = (await req('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...splitRepo(repo), issue_number: number, body, headers: headers(token) })).data as { id: number; html_url: string };
      return { id: d.id, url: d.html_url };
    }, failed(`a comment on ${repo}#${number}`)),
    editComment: (repo, id, body) => withToken(async (token) => {
      const d = (await req('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', { ...splitRepo(repo), comment_id: id, body, headers: headers(token) })).data as { id: number; html_url: string };
      return { id: d.id, url: d.html_url };
    }, failed(`the edit of a comment on ${repo}`)),
    find: (repo, key, where, since) => withToken(async (token) => {
      const at = { ...splitRepo(repo), since, per_page: 100, headers: headers(token) };
      if (where.kind === 'comment') {
        const d = (await req('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...at, issue_number: where.number })).data as { id: number; body?: string | null; html_url: string }[];
        const c = d.find((x) => hasPostKey(x.body, key));
        return c ? { number: where.number, url: c.html_url, commentId: c.id } : undefined;
      }
      const d = (await req('GET /repos/{owner}/{repo}/issues', { ...at, creator: where.creator, state: 'all' })).data as { number: number; body?: string | null; html_url: string; pull_request?: unknown }[];
      const i = d.find((x) => x.pull_request === undefined && hasPostKey(x.body, key));
      return i ? { number: i.number, url: i.html_url } : undefined;
    }, failed(`the post key on ${repo}`)),
  };
}
