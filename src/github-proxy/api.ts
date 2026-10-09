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
}

interface RestIssue { number: number; title: string; state: string; body?: string | null; html_url: string; user?: { login?: string } | null; labels?: ({ name?: string } | string)[]; pull_request?: unknown }
interface RestPull { number: number; title: string; state: string; body?: string | null; html_url: string; draft?: boolean; merged?: boolean; head: { ref: string }; base: { ref: string } }

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
  return {
    async perform(r) {
      const token = await o.token();
      try {
        return await call(req, token, r);
      } catch (err) {
        if (statusOf(err) !== 401) throw errorOf(err, r);
      }
      const renewed = await o.renew(token);
      try {
        return await call(req, renewed, r);
      } catch (err) {
        throw errorOf(err, r);
      }
    },
  };
}
