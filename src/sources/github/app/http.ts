// HTTP plumbing for the App adapter: one `@octokit/request` bound to the API base URL, through the shared rate limiter
// (issue #436), Link-header pagination, and the mapping of Octokit request errors onto GitHubApiError.

import { request as octokitRequest } from '@octokit/request';
import { githubLimiter, type GitHubLimiter } from '../../../github-limiter/limiter.ts';
import { GitHubApiError, isPermanent } from '../api.ts';

export type Request = typeof octokitRequest;

const MAX_PAGES = 100;

/** Every GitHub call of the hopper goes through one of these: `limiter` is the process's own unless a test gives one. */
export function makeRequest(baseUrl: string, limiter: GitHubLimiter = githubLimiter): Request {
  return octokitRequest.defaults({
    baseUrl,
    headers: { 'user-agent': 'hopper', 'x-github-api-version': '2022-11-28' },
    request: { hook: limiter.hook },
  });
}

function nextLink(link: string | undefined): string | undefined {
  return /<([^>]+)>;\s*rel="next"/.exec(link ?? '')?.[1];
}

/** Every page of `route`, following `Link: rel="next"`. `authorization` is the full header value. */
export async function paginate<T>(
  req: Request, route: string, params: Record<string, unknown>, authorization: string, pick: (data: unknown) => T[],
): Promise<T[]> {
  const headers = { authorization };
  const out: T[] = [];
  let r = await req(route, { ...params, headers });
  for (let page = 1; ; page++) {
    out.push(...pick(r.data));
    const next = nextLink(r.headers.link);
    if (!next || page >= MAX_PAGES) return out;
    r = await req(`GET ${next}`, { headers });
  }
}

/**
 * An Octokit RequestError (or anything else) as a GitHubApiError. A 401 is the app's credentials
 * being refused (wrong or revoked key, wrong app id): permanent, and the message names the file.
 */
export function toApiError(err: unknown, what: string, keyEnv: string): GitHubApiError {
  if (err instanceof GitHubApiError) return err;
  const e = err as { status?: unknown; message?: unknown };
  const status = typeof e.status === 'number' ? e.status : undefined;
  const message = typeof e.message === 'string' ? e.message : String(err);
  if (status === 401) {
    return new GitHubApiError(`${what}: GitHub rejected the app's credentials (401: ${message}); check the app id and ${keyEnv}`, true, 401);
  }
  return new GitHubApiError(`${what}: ${message}`, isPermanent(status, message), status);
}

export function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown }).status;
  return typeof s === 'number' ? s : undefined;
}

export function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new GitHubApiError(`not an owner/repo: ${repo}`, true);
  return { owner, repo: name };
}
