// Report a bug's GitHub calls (issue #694), with the person's own GitHub connection, so a report is filed as that person:
// the duplicate search over the open reports, filing one, and a comment on one. The same `@octokit/request` binding and
// token renewal as the GitHub proxy (src/github-proxy/api.ts).
import { tokenCaller, type TokenSource } from '../github-proxy/index.ts';
import { makeRequest, splitRepo, statusOf } from '../sources/github/app/http.ts';

/** An open report on GitHub. */
export interface SimilarReport { number: number; title: string; url: string }

export interface ReportGitHub {
  /** The open issues of `repo` with `label` whose title has any of `terms`; best match first is the caller's. */
  search(repo: string, label: string, terms: string[]): Promise<SimilarReport[]>;
  create(repo: string, issue: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }>;
  comment(repo: string, number: number, body: string): Promise<{ number: number; url: string }>;
}

/** GitHub's refusal or failure, with its status when it gave one. */
export class ReportGitHubError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ReportGitHubError';
    if (status !== undefined) this.status = status;
  }
}

const SEARCH_LIMIT = 20;

/** Search text cannot break out of a quoted term. */
const term = (t: string): string => `"${t.replaceAll('"', '')}"`;

export function createReportGitHub(o: { apiUrl: string } & TokenSource): ReportGitHub {
  const req = makeRequest(o.apiUrl);
  const withToken = tokenCaller(o);
  const failed = (what: string) => (err: unknown): Error => {
    const e = err as { message?: unknown; response?: { data?: { message?: unknown } } };
    const message = typeof e.response?.data?.message === 'string' ? e.response.data.message : String(e.message ?? err);
    return new ReportGitHubError(`GitHub answered ${statusOf(err) ?? 'no status'} to ${what}: ${message}`, statusOf(err));
  };
  const headers = (token: string) => ({ authorization: `token ${token}` });
  return {
    search: (repo, label, terms) => withToken(async (token) => {
      const q = `repo:${repo} is:issue is:open label:${label} in:title ${terms.map(term).join(' OR ')}`;
      const d = (await req('GET /search/issues', { q, per_page: SEARCH_LIMIT, headers: headers(token) })).data as { items: { number: number; title: string; html_url: string; pull_request?: unknown }[] };
      return d.items.filter((i) => i.pull_request === undefined).map((i) => ({ number: i.number, title: i.title, url: i.html_url }));
    }, failed(`the search of ${repo}`)),
    create: (repo, issue) => withToken(async (token) => {
      const d = (await req('POST /repos/{owner}/{repo}/issues', { ...splitRepo(repo), ...issue, headers: headers(token) })).data as { number: number; html_url: string };
      return { number: d.number, url: d.html_url };
    }, failed(`a new issue on ${repo}`)),
    comment: (repo, number, body) => withToken(async (token) => {
      const d = (await req('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...splitRepo(repo), issue_number: number, body, headers: headers(token) })).data as { html_url: string };
      return { number, url: d.html_url };
    }, failed(`a comment on ${repo}#${number}`)),
  };
}
