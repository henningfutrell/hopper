// The GitHub calls the hopper makes for a job (issue #563), with the hopper's own connection's token: one REST
// call per operation, through the same `@octokit/request` binding as the sources (src/sources/github/app/http.ts).
// `token()` is asked at every call; a token GitHub refuses (401) is renewed once and the call made again. A repository's
// read (`repo`) is what the contribution flow (issue #429) decides on: whether the user can push to it, whether it takes
// issues, and what it is a fork of. A fork made for a repository that takes no issues gets its own issues turned on.
import { MAX_JOB_LOG_CHARS, whyNoLog } from '../domain/check-logs.ts';
import { webOriginOf } from '../sources/github/api.ts';
import { jobLog } from '../sources/github/app/rest.ts';
import { makeRequest, splitRepo, statusOf, type Request } from '../sources/github/app/http.ts';
import { contributionSteps, type ProxyRequest } from './policy.ts';

/** What a done request answers the job: always where it is on GitHub; its number when it is an issue or pull request. */
export type ProxyResult = { number?: number; url: string } & Record<string, unknown>;

/** A repository as the connection's user sees it on GitHub (issue #429). */
export interface RepoFacts {
  url: string;
  defaultBranch: string;
  /** The user may push to it. */
  canPush: boolean;
  /** It takes issues. */
  hasIssues: boolean;
  /** It is a fork: of `parent`, whose own root is `source`. */
  fork: boolean;
  parent?: string;
  source?: string;
}

/** GitHub's own refusal or failure, with its status when it gave one. */
export class ProxyGitHubError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProxyGitHubError';
    if (status !== undefined) this.status = status;
  }
}

/** Where a filed issue is linked as a sub-issue (issue #729: a job's required child, under the job's own issue). */
export interface SubIssueOf { repo: string; number: number }

export interface ProxyApi {
  /**
   * Does the request on GitHub. `body` is the text to send (an issue's, with the hopper's note added). `subIssueOf`: a
   * filed issue is then linked as its sub-issue; a link GitHub refuses leaves the issue filed (`subIssue: false`, why).
   */
  perform(req: ProxyRequest, subIssueOf?: SubIssueOf): Promise<ProxyResult>;
  /** The repository as the user sees it (issue #652: its default branch, which a job's push never changes; issue #429: the rest). */
  repo(repo: string): Promise<RepoFacts>;
  /** The commit `ref` (a branch) of `repo` is at now (issue #870: the apply gate's check that the code did not move). */
  head(repo: string, ref: string): Promise<string>;
}

interface RestIssue { id?: number; number: number; title: string; state: string; body?: string | null; html_url: string; user?: { login?: string } | null; labels?: ({ name?: string } | string)[]; pull_request?: unknown }
interface RestRepo { full_name: string; html_url: string; default_branch: string; has_issues?: boolean; fork?: boolean; owner?: { login?: string }; permissions?: { push?: boolean }; parent?: { full_name?: string }; source?: { full_name?: string } }
interface RestPull { number: number; node_id?: string; title: string; state: string; body?: string | null; html_url: string; draft?: boolean; merged?: boolean; head: { ref: string }; base: { ref: string } }

const labelsOf = (i: RestIssue) => (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name ?? ''));

/** Links a filed issue as a sub-issue of `parent`. Never throws: the issue is filed whatever the link does. */
async function linkSubIssue(req: Request, headers: Record<string, string>, parent: SubIssueOf, childId: number | undefined): Promise<Record<string, unknown>> {
  if (childId === undefined) return { subIssue: false, subIssueError: `GitHub gave no id for the new issue, so it is not linked to ${parent.repo}#${parent.number}` };
  try {
    await req('POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', { ...splitRepo(parent.repo), issue_number: parent.number, sub_issue_id: childId, headers });
    return { subIssue: true };
  } catch (err) {
    return { subIssue: false, subIssueError: messageOf(err, `the sub-issue link to ${parent.repo}#${parent.number}`) };
  }
}

const factsOf = (d: RestRepo): RepoFacts => ({
  url: d.html_url, defaultBranch: d.default_branch, canPush: d.permissions?.push === true, hasIssues: d.has_issues !== false, fork: d.fork === true,
  ...(d.parent?.full_name ? { parent: d.parent.full_name } : {}), ...(d.source?.full_name ? { source: d.source.full_name } : {}),
});

async function readRepo(req: Request, headers: Record<string, string>, repo: string): Promise<RepoFacts> {
  return factsOf((await req('GET /repos/{owner}/{repo}', { ...splitRepo(repo), headers })).data as RestRepo);
}

/**
 * Forks the repository into the user's account, or answers the fork the user has (GitHub makes one only once). A
 * repository that takes no issues: the fork's issues are turned on, so the job files its issue there; a refusal says why.
 */
async function fork(req: Request, headers: Record<string, string>, repo: string): Promise<ProxyResult> {
  const upstream = await readRepo(req, headers, repo);
  const d = (await req('POST /repos/{owner}/{repo}/forks', { ...splitRepo(repo), default_branch_only: true, headers })).data as RestRepo;
  const login = d.owner?.login ?? d.full_name.split('/')[0]!;
  let issues: string | undefined = repo;
  let issuesError: string | undefined;
  if (!upstream.hasIssues) {
    try {
      await req('PATCH /repos/{owner}/{repo}', { ...splitRepo(d.full_name), has_issues: true, headers });
      issues = d.full_name;
    } catch (err) {
      issues = undefined;
      issuesError = messageOf(err, `turning on the issues of ${d.full_name}`);
    }
  }
  return {
    url: d.html_url, fork: d.full_name, defaultBranch: d.default_branch, ...(issues ? { issues } : {}), ...(issuesError ? { issuesError } : {}),
    next: contributionSteps(repo, d.full_name, d.html_url, login, issues),
  };
}

/**
 * A failed check's full log (issue #993): its end when it is longer than `MAX_JOB_LOG_CHARS`, where the failure is. Read
 * through the shared rate limiter as every call; its link is the check run's page, which GitHub names by the job's id.
 */
async function checkLog(req: Request, token: string, webOrigin: string, repo: string, job: number): Promise<ProxyResult> {
  const log = await jobLog(req, token, repo, job);
  const truncated = log.length > MAX_JOB_LOG_CHARS;
  return { number: job, url: `${webOrigin}/${repo}/runs/${job}`, log: truncated ? log.slice(-MAX_JOB_LOG_CHARS) : log, ...(truncated ? { truncated: true } : {}) };
}

async function call(req: Request, token: string, r: ProxyRequest, webOrigin: string, subIssueOf?: SubIssueOf): Promise<ProxyResult> {
  const headers = { authorization: `token ${token}` };
  const at = splitRepo(r.repo);
  switch (r.op) {
    case 'repo.view': return { ...(await readRepo(req, headers, r.repo)) };
    case 'repo.fork': return fork(req, headers, r.repo);
    case 'check.log': return checkLog(req, token, webOrigin, r.repo, r.number);
    case 'issue.create': {
      const d = (await req('POST /repos/{owner}/{repo}/issues', { ...at, title: r.title, body: r.body, headers })).data as RestIssue;
      return { number: d.number, url: d.html_url, ...(subIssueOf ? await linkSubIssue(req, headers, subIssueOf, d.id) : {}) };
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

/** GitHub's message for a failed call to `what`, as the job reads it. */
function messageOf(err: unknown, what: string): string {
  const e = err as { message?: unknown; response?: { data?: { message?: unknown; errors?: { message?: unknown }[] } } };
  const detail = e.response?.data?.errors?.map((x) => (typeof x.message === 'string' ? x.message : '')).filter(Boolean).join('; ');
  const message = typeof e.response?.data?.message === 'string' ? e.response.data.message : typeof e.message === 'string' ? e.message : String(err);
  return `GitHub answered ${statusOf(err) ?? 'no status'} to ${what}: ${message}${detail ? ` (${detail})` : ''}`;
}

/** GitHub's failure as the job reads it; for a check's log (issue #993), why the hopper could not read it. */
function errorOf(err: unknown, r: ProxyRequest): ProxyGitHubError {
  if (r.op !== 'check.log') return new ProxyGitHubError(messageOf(err, `${r.op} on ${r.repo}`), statusOf(err));
  const e = err as { message?: unknown; response?: { data?: { message?: unknown } } };
  const message = typeof e.response?.data?.message === 'string' ? e.response.data.message : typeof e.message === 'string' ? e.message : String(err);
  return new ProxyGitHubError(`the log of Actions job ${r.number} of ${r.repo}: ${whyNoLog(statusOf(err), message)}`, statusOf(err));
}

/** The user's token as asked at each call: renewed once when GitHub refuses it (401), and the call made again. */
export interface TokenSource { token(): Promise<string>; renew(refused: string): Promise<string> }

/** `fn` with the token; GitHub refusing it (401) renews it once and `fn` runs again. Every other failure is `fail(err)`. */
export function tokenCaller(o: TokenSource): <T>(fn: (token: string) => Promise<T>, fail: (err: unknown) => Error) => Promise<T> {
  return async (fn, fail) => {
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
  };
}

export function createProxyApi(o: { apiUrl: string } & TokenSource): ProxyApi {
  const req = makeRequest(o.apiUrl);
  const withToken = tokenCaller(o);
  return {
    perform: (r, subIssueOf) => withToken((token) => call(req, token, r, webOriginOf(o.apiUrl), subIssueOf), (err) => errorOf(err, r)),
    repo: (repo) => withToken(
      (token) => readRepo(req, { authorization: `token ${token}` }, repo),
      (err) => new ProxyGitHubError(`GitHub answered ${statusOf(err) ?? 'no status'} reading ${repo}: ${(err as Error).message}`, statusOf(err)),
    ),
    head: (repo, ref) => withToken(
      async (token) => ((await req('GET /repos/{owner}/{repo}/commits/{ref}', { ...splitRepo(repo), ref, headers: { authorization: `token ${token}` } })).data as { sha: string }).sha,
      (err) => new ProxyGitHubError(messageOf(err, `the head of ${repo} ${ref}`), statusOf(err)),
    ),
  };
}
