// What GitHub shows of a repository's checks (issue #677), read with the person's own GitHub connection, and the
// "Add PR checks" job filed as their own issue. Required checks: the default branch's protection and its rulesets.
// Workflows: the files in `.github/workflows` (the contents permission the hopper's app has; the Actions API needs
// one it does not ask for). Recent checks: the status check rollup of the newest pull requests, through GraphQL, as the
// GitHub source reads it. The same `@octokit/request` binding and token renewal as Report a bug. The repository's setup
// (issue #652) is read beside them (setup.ts); its default branch's required checks are the ones read there.
// Every GET is conditional (issue #1250, conditional.ts): an unchanged answer is a 304, which costs no call. GraphQL has
// no conditional request, so the pull requests' checks are read only when they decide: no required check and no
// workflow on pull requests was found (else `pullRequests` is `{ read: 0, withChecks: 0 }`).
import { tokenCaller, type TokenSource } from '../github-proxy/index.ts';
import { makeRequest, retryAtOf, splitRepo, statusOf } from '../sources/github/app/http.ts';
import { explained, permissionsOfError, permissionsOfPath } from '../sources/github/app/refusal.ts';
import { runsOnPullRequests, type RepoChecksFound } from '../domain/types.ts';
import type { ConditionalAnswers, Get } from './conditional.ts';
import { createSetupReader, type Read, type RepoAnswer } from './setup.ts';

/** The repository itself: read first, the anchor of a read's kept refusals (conditional.ts). */
export const REPO_ROUTE = 'GET /repos/{owner}/{repo}';

/** The newest pull requests read for their checks. */
export const RECENT_PULL_REQUESTS = 5;

export interface RepoChecksGitHub {
  /** What GitHub shows of the repository's checks, each GET through `answers`. */
  found(repo: string, answers: ConditionalAnswers): Promise<RepoChecksFound>;
  /** The open issue with `label` and exactly this title, when there is one; through `answers` when given. */
  openIssue(repo: string, label: string, title: string, answers?: ConditionalAnswers): Promise<{ number: number; url: string } | undefined>;
  file(repo: string, issue: { title: string; body: string; labels: string[]; assignees: string[] }): Promise<{ number: number; url: string }>;
}

/** GitHub's refusal or failure, with its status when it gave one, and when its rate limit lets the read go again. */
export class RepoChecksGitHubError extends Error {
  readonly status?: number;
  readonly retryAt?: number;
  constructor(message: string, status?: number, retryAt?: number) {
    super(message);
    this.name = 'RepoChecksGitHubError';
    if (status !== undefined) this.status = status;
    if (retryAt !== undefined) this.retryAt = retryAt;
  }
}

const ROLLUPS = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(last: $n) { nodes { commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }
  }
}`;

interface Rollups { repository?: { pullRequests?: { nodes?: ({ commits?: { nodes?: ({ commit?: { statusCheckRollup?: unknown } } | null)[] } } | null)[] } } | null }

/** `installUrl`: the hopper's app's install link, which a refusal gives (issue #1351). */
export function createRepoChecksGitHub(o: { apiUrl: string; installUrl?: string | undefined } & TokenSource): RepoChecksGitHub {
  const req = makeRequest(o.apiUrl);
  const asGet = req as unknown as Get;
  const withToken = tokenCaller(o);
  const failed = (what: string) => (err: unknown): Error => {
    const e = err as { message?: unknown; response?: { data?: { message?: unknown } } };
    const message = typeof e.response?.data?.message === 'string' ? e.response.data.message : String(e.message ?? err);
    return new RepoChecksGitHubError(`GitHub answered ${statusOf(err) ?? 'no status'} to ${what}: ${explained(message, permissionsOfError(err), o.installUrl)}`, statusOf(err), retryAtOf(err));
  };
  const headers = (token: string) => ({ authorization: `token ${token}` });
  /** A 404 is "there is none" (no workflows folder, no rulesets); anything else throws. */
  const orNone = async <T>(p: Promise<T>, none: T): Promise<T> => {
    try {
      return await p;
    } catch (err) {
      if (statusOf(err) === 404) return none;
      throw err;
    }
  };

  async function workflows(get: Read, token: string, repo: string, branch: string): Promise<string[]> {
    const at = { ...splitRepo(repo), ref: branch, headers: headers(token) };
    const files = await orNone(get<{ name: string; path: string; type: string }[]>('GET /repos/{owner}/{repo}/contents/.github/workflows', at), []);
    const found: string[] = [];
    for (const f of files.filter((x) => x.type === 'file' && /\.ya?ml$/i.test(x.name))) {
      const d = await get<{ content?: string; encoding?: string }>('GET /repos/{owner}/{repo}/contents/.github/workflows/{name}', { ...at, name: f.name });
      if (runsOnPullRequests(Buffer.from(d.content ?? '', d.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'))) found.push(f.name);
    }
    return found;
  }

  async function pullRequests(token: string, repo: string): Promise<RepoChecksFound['pullRequests']> {
    const { owner, repo: name } = splitRepo(repo);
    const d = (await req('POST /graphql', { query: ROLLUPS, variables: { owner, name, n: RECENT_PULL_REQUESTS }, headers: headers(token) })).data as { data?: Rollups; errors?: { message: string; path?: (string | number)[] }[] };
    if (d.errors?.length) {
      const said = [...new Set(d.errors.map((e) => explained(e.message, permissionsOfPath(e.path), o.installUrl)))];
      throw new RepoChecksGitHubError(`GitHub answered the pull requests of ${repo} with: ${said.join('; ')}`);
    }
    const nodes = d.data?.repository?.pullRequests?.nodes ?? [];
    return { read: nodes.length, withChecks: nodes.filter((n) => n?.commits?.nodes?.[0]?.commit?.statusCheckRollup).length };
  }

  return {
    found: (repo, answers) => withToken(async (token) => {
      const get: Read = (route, params) => answers.get(asGet, route, params);
      const answer = await get<RepoAnswer>(REPO_ROUTE, { ...splitRepo(repo), headers: headers(token) });
      const branch = answer.default_branch;
      const [s, w] = await Promise.all([createSetupReader(get).read(token, repo, answer), workflows(get, token, repo, branch)]);
      // The default branch is read first: its required checks are the repository's.
      const required = s.branches[0]?.checks ?? [];
      const p = required.length > 0 || w.length > 0 ? { read: 0, withChecks: 0 } : await pullRequests(token, repo);
      return { required, workflows: w, pullRequests: p, setup: s.setup };
    }, failed(`the checks of ${repo}`)),
    openIssue: (repo, label, title, answers) => withToken(async (token) => {
      type Issue = { number: number; title: string; html_url: string; pull_request?: unknown };
      const params = { ...splitRepo(repo), state: 'open', labels: label, per_page: 100, headers: headers(token) };
      const route = 'GET /repos/{owner}/{repo}/issues';
      const d = answers ? await answers.get<Issue[]>(asGet, route, params) : (await asGet(route, params)).data as Issue[];
      const i = d.find((x) => x.pull_request === undefined && x.title === title);
      return i ? { number: i.number, url: i.html_url } : undefined;
    }, failed(`the open issues of ${repo}`)),
    file: (repo, issue) => withToken(async (token) => {
      const d = (await req('POST /repos/{owner}/{repo}/issues', { ...splitRepo(repo), ...issue, headers: headers(token) })).data as { number: number; html_url: string };
      return { number: d.number, url: d.html_url };
    }, failed(`a new issue on ${repo}`)),
  };
}
