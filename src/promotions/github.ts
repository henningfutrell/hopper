// Promote to GitHub's calls (issue #946), with the promoting person's own GitHub connection, never a job's: a repository's
// visibility, the issue a comment goes on, a new issue, an issue edited, its labels added, a comment and a comment
// edited. The same `@octokit/request` binding and token renewal as Report a bug (src/bug-reports/github.ts).
import type { RepoVisibility } from '../domain/promotions.ts';
import { tokenCaller, type TokenSource } from '../github-proxy/index.ts';
import { makeRequest, splitRepo, statusOf } from '../sources/github/app/http.ts';

export interface PromotionGitHub {
  repo(repo: string): Promise<{ visibility: RepoVisibility; hasIssues: boolean }>;
  /** An issue, or a pull request, by number: what a comment goes on. */
  issue(repo: string, number: number): Promise<{ number: number; url: string; state: 'open' | 'closed' }>;
  create(repo: string, issue: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }>;
  edit(repo: string, number: number, issue: { title: string; body: string }): Promise<{ number: number; url: string }>;
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
  comment(repo: string, number: number, body: string): Promise<{ id: number; url: string }>;
  editComment(repo: string, id: number, body: string): Promise<{ id: number; url: string }>;
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
      const d = (await req('GET /repos/{owner}/{repo}', { ...splitRepo(repo), headers: headers(token) })).data as { private?: boolean; visibility?: string; has_issues?: boolean };
      const visibility: RepoVisibility = d.visibility === 'internal' ? 'internal' : d.private === true || d.visibility === 'private' ? 'private' : 'public';
      return { visibility, hasIssues: d.has_issues !== false };
    }, failed(`the repository ${repo}`)),
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
  };
}
