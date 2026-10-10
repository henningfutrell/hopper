// The GitHub calls the hopper makes for a job (issue #563), with the hopper's own connection's token: one REST
// call per operation, through the same `@octokit/request` binding as the sources (src/sources/github/app/http.ts).
// `token()` is asked at every call; a token GitHub refuses (401) is renewed once and the call made again.
import { makeRequest, splitRepo, statusOf, type Request } from '../sources/github/app/http.ts';
import type { ProxyRequest } from './policy.ts';

/** What a done request answers the job: always where it is on GitHub. */
export type ProxyResult = { number: number; url: string } & Record<string, unknown>;

/** GitHub's own refusal or failure, with its status when it gave one. */
export class ProxyGitHubError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProxyGitHubError';
    if (status !== undefined) this.status = status;
  }
}

export interface ProxyApi {
  /** Does the request on GitHub. `body` is the text to send (an issue's, with the hopper's note added). */
  perform(req: ProxyRequest): Promise<ProxyResult>;
  /** The repository's default branch (issue #652: what a job's push never changes). */
  defaultBranch(repo: string): Promise<string>;
}

interface RestIssue { number: number; title: string; state: string; body?: string | null; html_url: string; user?: { login?: string } | null; labels?: ({ name?: string } | string)[]; pull_request?: unknown }
interface RestPull { number: number; node_id?: string; title: string; state: string; body?: string | null; html_url: string; draft?: boolean; merged?: boolean; head: { ref: string }; base: { ref: string } }

const labelsOf = (i: RestIssue) => (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? ''));

async function call(req: Request, token: string, r: ProxyRequest): Promise<ProxyResult> {
  const headers = { authorization: `token ${token}` };
  const at = splitRepo(r.repo);
  switch (r.op) {
    case 'issue.create': {
      const d = (await req('POST /repos/{owner}/{repo}/issues', { ...at, title: r.title, body: r.body, headers })).data as RestIssue;
      return { number: d.number, url: d.html_url };
    }
    case 'issue.comment': {
      const d = (await req('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...at, issue_number: r.number, body: r.body, headers })).data as { html_url: string };
      return { number: r.number, url: d.html_url };
    }
    case 'issue.view': {
      const d = (await req('GET /repos/{owner}/{repo}/issues/{issue_number}', { ...at, issue_number: r.number, headers })).data as RestIssue;
      return { number: d.number, url: d.html_url, title: d.title, state: d.state, author: d.user?.login ?? '', labels: labelsOf(d), body: d.body ?? '', pullRequest: d.pull_request !== undefined };
    }
    case 'pr.view': {
      const d = (await req('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...at, pull_number: r.number, headers })).data as RestPull;
      return { number: d.number, url: d.html_url, title: d.title, state: d.state, merged: d.merged === true, draft: d.draft === true, head: d.head.ref, base: d.base.ref, body: d.body ?? '' };
    }
    case 'issue.close': {
      const d = (await req('PATCH /repos/{owner}/{repo}/issues/{issue_number}', { ...at, issue_number: r.number, state: 'closed', state_reason: 'completed', headers })).data as RestIssue;
      return { number: d.number, url: d.html_url, state: d.state };
    }
    case 'pr.ready': {
      const pull = (await req('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...at, pull_number: r.number, headers })).data as RestPull;
      if (pull.draft) {
        const query = 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }';
        const d = (await req('POST /graphql', { query, variables: { id: pull.node_id }, headers })).data as { errors?: { message?: string }[] };
        if (d.errors?.length) throw new Error(d.errors.map((e) => e.message ?? '').join('; '));
      }
      return { number: pull.number, url: pull.html_url, draft: false };
    }
    case 'pr.create': {
      const base = r.base ?? ((await req('GET /repos/{owner}/{repo}', { ...at, headers })).data as { default_branch: string }).default_branch;
      const d = (await req('POST /repos/{owner}/{repo}/pulls', { ...at, head: r.head, base, title: r.title, body: r.body, headers })).data as RestPull;
      return { number: d.number, url: d.html_url, head: d.head.ref, base: d.base.ref };
    }
  }
}

/** GitHub's message for a failed call, as the job reads it. */
function errorOf(err: unknown, r: ProxyRequest): ProxyGitHubError {
  const e = err as { message?: unknown; response?: { data?: { message?: unknown; errors?: { message?: unknown }[] } } };
  const status = statusOf(err);
  const detail = e.response?.data?.errors?.map((x) => (typeof x.message === 'string' ? x.message : '')).filter(Boolean).join('; ');
  const message = typeof e.response?.data?.message === 'string' ? e.response.data.message : typeof e.message === 'string' ? e.message : String(err);
  return new ProxyGitHubError(`GitHub answered ${status ?? 'no status'} to ${r.op} on ${r.repo}: ${message}${detail ? ` (${detail})` : ''}`, status);
}

export function createProxyApi(o: { apiUrl: string; token(): Promise<string>; renew(refused: string): Promise<string> }): ProxyApi {
  const req = makeRequest(o.apiUrl);
  /** One call with the token; GitHub refusing it (401) renews it once and the call is made again. */
  async function withToken<T>(fn: (token: string) => Promise<T>, fail: (err: unknown) => Error): Promise<T> {
    const token = await o.token();
    try {
      return await fn(token);
    } catch (err) {
      if (statusOf(err) !== 401) throw fail(err);
    }
    const renewed = await o.renew(token);
    try {
      return await fn(renewed);
    } catch (err) {
      // GitHub refusing the token it just renewed is GitHub refusing the connection (issue #647): the renewer ends it.
      if (statusOf(err) === 401) await o.renew(renewed).catch(() => undefined);
      throw fail(err);
    }
  }
  return {
    perform: (r) => withToken((token) => call(req, token, r), (err) => errorOf(err, r)),
    defaultBranch: (repo) => withToken(
      async (token) => ((await req('GET /repos/{owner}/{repo}', { ...splitRepo(repo), headers: { authorization: `token ${token}` } })).data as { default_branch: string }).default_branch,
      (err) => new ProxyGitHubError(`GitHub answered ${statusOf(err) ?? 'no status'} reading ${repo}: ${(err as Error).message}`, statusOf(err)),
    ),
  };
}
