// Report a bug's GitHub calls (issue #694), with the person's own GitHub connection, so a report is filed as that person:
// the duplicate search over the open reports, filing one, a comment on one, a report's state, and the look-up for a report's
// post key (issue #1591). The same `@octokit/request` binding and
// token renewal as the GitHub proxy (src/github-proxy/api.ts).
import { hasPostKey } from '../domain/post-key.ts';
import { tokenCaller, type TokenSource } from '../github-proxy/index.ts';
import { makeRequest, splitRepo, statusOf } from '../sources/github/http/http.ts';

/** An open report on GitHub. */
export interface SimilarReport { number: number; title: string; url: string }

export interface ReportGitHub {
  /** The open issues of `repo` with `label` whose title has any of `terms`; best match first is the caller's. */
  search(repo: string, label: string, terms: string[]): Promise<SimilarReport[]>;
  create(repo: string, issue: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }>;
  comment(repo: string, number: number, body: string): Promise<{ number: number; url: string }>;
  /** The issue's state now (Your reports); closed: when, and why (issue #1147: `completed`, its fix landed). */
  state(repo: string, number: number): Promise<ReportState>;
  /**
   * The issue the connection's account made, or the comment on issue `number`, whose text carries the post key `key`, made
   * or changed since `since` (issue #1591); undefined: none. By its author, not its label: GitHub drops the label of a
   * person who may not triage.
   */
  find(repo: string, key: string, where: { kind: 'issue' } | { kind: 'comment'; number: number }, since: string): Promise<{ number: number; url: string } | undefined>;
}

export type ReportState = { state: 'open' } | { state: 'closed'; closedAt?: string; closedAs?: string };

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
    state: (repo, number) => withToken(async (token) => {
      const d = (await req('GET /repos/{owner}/{repo}/issues/{issue_number}', { ...splitRepo(repo), issue_number: number, headers: headers(token) })).data as { state: string; closed_at?: string | null; state_reason?: string | null };
      if (d.state !== 'closed') return { state: 'open' };
      return { state: 'closed', ...(d.closed_at ? { closedAt: d.closed_at } : {}), ...(d.state_reason ? { closedAs: d.state_reason } : {}) };
    }, failed(`the state of ${repo}#${number}`)),
    find: (repo, key, where, since) => withToken(async (token) => {
      const at = { ...splitRepo(repo), since, per_page: 100, headers: headers(token) };
      if (where.kind === 'comment') {
        const d = (await req('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...at, issue_number: where.number })).data as { body?: string | null; html_url: string }[];
        const c = d.find((x) => hasPostKey(x.body, key));
        return c ? { number: where.number, url: c.html_url } : undefined;
      }
      const creator = ((await req('GET /user', { headers: headers(token) })).data as { login: string }).login;
      const d = (await req('GET /repos/{owner}/{repo}/issues', { ...at, creator, state: 'all' })).data as { number: number; body?: string | null; html_url: string; pull_request?: unknown }[];
      const i = d.find((x) => x.pull_request === undefined && hasPostKey(x.body, key));
      return i ? { number: i.number, url: i.html_url } : undefined;
    }, failed(`the post key on ${repo}`)),
  };
}
