// What GitHub shows of the accounts a person may trust (issue #930, design.md "Trusted origin and request cards"), read
// with the person's own GitHub connection through `@octokit/request`, as Report a bug and the repositories' checks are:
// one account by user id or by login, a repository's collaborators, an organization's members, and the authors of a
// repository's newest issues. One page of each: the picker offers, it does not list GitHub.
import { tokenCaller, type TokenSource } from '../github-proxy/index.ts';
import { makeRequest, splitRepo, statusOf } from '../sources/github/app/http.ts';
import type { GitHubAccount } from '../domain/intake-origin.ts';

/** The newest issues of a repository read for their authors. */
export const RECENT_ISSUES = 50;

export interface ActorsGitHub {
  /** The account with this GitHub user id; undefined: GitHub knows none. */
  byId(id: number): Promise<GitHubAccount | undefined>;
  /** The account with this login (GitHub logins compare without case); undefined: GitHub knows none. */
  byLogin(login: string): Promise<GitHubAccount | undefined>;
  /** The repository's collaborators; GitHub shows them only to who can push to it. */
  collaborators(repo: string): Promise<GitHubAccount[]>;
  /** The organization's members the connection can see; undefined: `org` is no organization. */
  members(org: string): Promise<GitHubAccount[] | undefined>;
  /** Who wrote the repository's newest issues and pull requests, newest first. */
  recentAuthors(repo: string): Promise<GitHubAccount[]>;
}

/** GitHub's refusal or failure, with its status when it gave one. */
export class ActorsGitHubError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ActorsGitHubError';
    if (status !== undefined) this.status = status;
  }
}

interface RestUser { id?: number; login?: string; type?: string; avatar_url?: string }

/** An account as GitHub answers it; undefined when GitHub left out its id or login. */
export function accountFrom(u: RestUser | null | undefined): GitHubAccount | undefined {
  if (typeof u?.id !== 'number' || !u.login) return undefined;
  return { id: u.id, login: u.login, type: u.type ?? 'User', ...(u.avatar_url ? { avatarUrl: u.avatar_url } : {}) };
}

const accounts = (d: unknown): GitHubAccount[] => (Array.isArray(d) ? d.map((u) => accountFrom(u as RestUser)).filter((a): a is GitHubAccount => a !== undefined) : []);

export function createActorsGitHub(o: { apiUrl: string } & TokenSource): ActorsGitHub {
  const req = makeRequest(o.apiUrl);
  const withToken = tokenCaller(o);
  const headers = (token: string) => ({ authorization: `token ${token}` });
  const failed = (what: string) => (err: unknown): Error => {
    const e = err as { message?: unknown; response?: { data?: { message?: unknown } } };
    const message = typeof e.response?.data?.message === 'string' ? e.response.data.message : String(e.message ?? err);
    return new ActorsGitHubError(`GitHub answered ${statusOf(err) ?? 'no status'} to ${what}: ${message}`, statusOf(err));
  };
  /** A 404 is "there is none"; anything else throws. */
  const orNone = async <T>(p: Promise<T>): Promise<T | undefined> => {
    try {
      return await p;
    } catch (err) {
      if (statusOf(err) === 404) return undefined;
      throw err;
    }
  };
  return {
    byId: (id) => withToken(async (token) => accountFrom(await orNone(req('GET /user/{account_id}', { account_id: id, headers: headers(token) }).then((r) => r.data as RestUser))), failed(`the account ${id}`)),
    byLogin: (login) => withToken(async (token) => accountFrom(await orNone(req('GET /users/{username}', { username: login, headers: headers(token) }).then((r) => r.data as RestUser))), failed(`the account ${login}`)),
    collaborators: (repo) => withToken(async (token) => accounts((await req('GET /repos/{owner}/{repo}/collaborators', { ...splitRepo(repo), per_page: 100, headers: headers(token) })).data), failed(`the collaborators of ${repo}`)),
    members: (org) => withToken(async (token) => {
      const d = await orNone(req('GET /orgs/{org}/members', { org, per_page: 100, headers: headers(token) }).then((r) => r.data));
      return d === undefined ? undefined : accounts(d);
    }, failed(`the members of ${org}`)),
    recentAuthors: (repo) => withToken(async (token) => {
      const d = (await req('GET /repos/{owner}/{repo}/issues', { ...splitRepo(repo), state: 'all', sort: 'created', direction: 'desc', per_page: RECENT_ISSUES, headers: headers(token) })).data;
      return accounts(Array.isArray(d) ? d.map((i) => (i as { user?: RestUser }).user) : []);
    }, failed(`the issues of ${repo}`)),
  };
}
