// The GitHub calls the hopper makes for a job (issue #563), with the token of the job's user's connection (issue #1380): one REST
// call per operation, through the same `@octokit/request` binding as the sources (src/sources/github/http/http.ts).
// `token()` is asked at every call; a token GitHub refuses (401) is renewed once and the call made again. A repository's
// read (`repo`) is what the contribution flow (issue #429) decides on: whether the user can push to it, whether it takes
// issues, and what it is a fork of. A fork made for a repository that takes no issues gets its own issues turned on.
// The repo queries (issue #1074): a pull request's diff (from its files' patches), its commits and the check runs and
// statuses of its head commit, and an issue's comments — every page, each answer with the item's own URL.
import { whyNoLog } from '../domain/check-logs.ts';
import type { GitHubCallKind } from '../domain/github-rate-limit.ts';
import { webOriginOf } from '../sources/github/api.ts';
import { ACCOUNT_CONNECTION, checksLack } from '../sources/github/checks-fallback.ts';
import { explained, notAccessible, permissionsOfError } from '../sources/github/http/refusal.ts';
import { fileAssignedIssue } from '../sources/github/http/file-issue.ts';
import { newestRuns } from '../sources/github/newest-runs.ts';
import { makeRequest, paginate, splitRepo, statusOf, type Request } from '../sources/github/http/http.ts';
import { contributionSteps, type ProxyRequest } from './policy.ts';
import { findFiled, passProxyKillPoint } from './resend.ts';
import { checkLog, listRuns, viewRun } from './runs.ts';
import type { PullRequestStatus } from './pr-status.ts';

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

/** What a filed issue is given beside its text: its sub-issue link, and, routed (issue #1510), its labels and assignees. */
export interface FiledWith { subIssueOf?: SubIssueOf; labels?: string[]; assignees?: string[] }

export interface ProxyApi {
  /**
   * Does the request on GitHub. `body` is the text to send (an issue's, with the hopper's note added). `filed.subIssueOf`:
   * a filed issue is then linked as its sub-issue; a link GitHub refuses leaves the issue filed (`subIssue: false`, why).
   * `filed.labels`, `filed.assignees`: a routed child's (issue #1510), set as it is filed.
   */
  perform(req: ProxyRequest, filed?: FiledWith): Promise<ProxyResult>;
  /**
   * An issue create or comment sent before, found on GitHub by its post key (issue #1959 part 2, resend.ts): the issue
   * `login` made, or the comment, made since `since`; undefined: none, so it is made now. A found issue with
   * `filed.subIssueOf` is linked as its sub-issue, unless it is one already. Absent (a test's double): nothing is looked for.
   */
  find?(req: ProxyRequest, postKey: string, since: string, login: string, filed?: FiledWith): Promise<ProxyResult | undefined>;
  /** The repository as the user sees it (issue #652: its default branch, which a job's push never changes; issue #429: the rest). */
  repo(repo: string): Promise<RepoFacts>;
  /** The commit `ref` (a branch) of `repo` is at now (issue #870: the apply gate's check that the code did not move). */
  head(repo: string, ref: string): Promise<string>;
  /** The base branch of the open pull request from `branch` of `repo` into it; undefined: none (issue #1147: the shrink guard's base). */
  pullRequestBase(repo: string, branch: string): Promise<string | undefined>;
  /** The open pull request from `branch` of `repo` into it, its number and body; undefined: none (issue #2555 part 4: the push requirements summary). Absent: none is read. */
  pullRequestOf?(repo: string, branch: string): Promise<{ number: number; body: string } | undefined>;
}

interface RestIssue { id?: number; number: number; title: string; state: string; body?: string | null; html_url: string; user?: { login?: string } | null; labels?: ({ name?: string } | string)[]; pull_request?: unknown }
interface RestRepo { full_name: string; html_url: string; default_branch: string; has_issues?: boolean; fork?: boolean; owner?: { login?: string }; permissions?: { push?: boolean }; parent?: { full_name?: string }; source?: { full_name?: string } }
interface RestPull { number: number; node_id?: string; title: string; state: string; body?: string | null; html_url: string; draft?: boolean; merged?: boolean; mergeable?: boolean | null; head: { ref: string; sha?: string }; base: { ref: string } }
interface RestFile { filename: string; status: string; additions: number; deletions: number; patch?: string; previous_filename?: string }
interface RestCommit { sha: string; html_url?: string; commit: { message: string; author?: { name?: string; date?: string } | null }; author?: { login?: string } | null }
interface RestCheckRun { id: number; name: string; status: string; conclusion: string | null; html_url?: string | null; details_url?: string | null; started_at?: string | null; completed_at?: string | null }
interface RestStatus { context: string; state: string; target_url?: string | null; description?: string | null }
interface RestReview { id: number; state: string; body?: string | null; html_url?: string; submitted_at?: string | null; user?: { login?: string } | null }
interface RestComment { id: number; body?: string | null; html_url: string; created_at: string; user?: { login?: string } | null }

/** A pull request's diff a job is answered at most (issue #1074): its start, then `truncated`. Its files are listed whole. */
export const MAX_DIFF_CHARS = 200_000;

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

/** A pull request's diff (issue #1074): each file's patch as `git diff` writes it; a binary or too large file has none. */
async function pullDiff(req: Request, token: string, r: { repo: string; number: number }, url: string): Promise<ProxyResult> {
  const files = await paginate<RestFile>(req, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files', { ...splitRepo(r.repo), pull_number: r.number, per_page: 100 }, `token ${token}`, (d) => d as RestFile[]);
  const diff = files.map((f) => {
    const from = f.previous_filename ?? f.filename;
    const head = `diff --git a/${from} b/${f.filename}\n--- ${f.status === 'added' ? '/dev/null' : `a/${from}`}\n+++ ${f.status === 'removed' ? '/dev/null' : `b/${f.filename}`}\n`;
    return f.patch === undefined ? `${head}(no patch: binary, or too large for GitHub to show)\n` : `${head}${f.patch}\n`;
  }).join('');
  const truncated = diff.length > MAX_DIFF_CHARS;
  return {
    number: r.number, url,
    files: files.map((f) => ({ file: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, ...(f.previous_filename ? { from: f.previous_filename } : {}) })),
    diff: truncated ? diff.slice(0, MAX_DIFF_CHARS) : diff, ...(truncated ? { truncated: true } : {}),
  };
}

/** GitHub refused the read to the connection (403, 404), not a rate limit: a permission is missing (issue #1244). */
const refusedRead = (err: unknown): boolean => {
  const s = statusOf(err);
  return (s === 403 || s === 404) && !/rate limit/i.test(String((err as { message?: unknown }).message ?? ''));
};

/**
 * The check runs and the statuses of a pull request's head commit (issue #1074): each run's id is its `check log` job.
 * One of the two GitHub refuses (issue #1279): the other, with `unreadable` and why (`checksWhy`); both: the refusal, with why.
 */
async function pullChecks(req: Request, token: string, r: { repo: string; number: number }): Promise<ProxyResult> {
  const headers = { authorization: `token ${token}` };
  const at = splitRepo(r.repo);
  const pull = (await req('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...at, pull_number: r.number, headers })).data as RestPull;
  const sha = pull.head.sha ?? '';
  const [runs, statuses] = await Promise.allSettled([
    paginate<RestCheckRun>(req, 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs', { ...at, ref: sha, per_page: 100 }, `token ${token}`, (d) => (d as { check_runs: RestCheckRun[] }).check_runs),
    req('GET /repos/{owner}/{repo}/commits/{ref}/status', { ...at, ref: sha, headers }).then((d) => (d.data as { statuses?: RestStatus[] }).statuses ?? []),
  ]);
  const unreadable: ('checks' | 'statuses')[] = [];
  for (const [got, what] of [[runs, 'checks'], [statuses, 'statuses']] as const) {
    if (got.status === 'rejected' && !refusedRead(got.reason)) throw got.reason;
    if (got.status === 'rejected') unreadable.push(what);
  }
  const why = unreadable.length ? { unreadable, checksWhy: checksLack(ACCOUNT_CONNECTION, unreadable) } : {};
  if (runs.status === 'rejected' && statuses.status === 'rejected') {
    const message = String((runs.reason as { response?: { data?: { message?: unknown } } }).response?.data?.message ?? (runs.reason as Error).message);
    throw new ProxyGitHubError(`${message} (${why.checksWhy})`, statusOf(runs.reason));
  }
  return {
    number: pull.number, url: pull.html_url, state: pull.state, merged: pull.merged === true, head: pull.head.ref, headSha: sha,
    checks: (runs.status === 'fulfilled' ? runs.value : []).map((c) => ({ id: c.id, name: c.name, status: c.status, conclusion: c.conclusion, ...(c.html_url ? { url: c.html_url } : {}), ...(c.started_at ? { startedAt: c.started_at } : {}), ...(c.completed_at ? { completedAt: c.completed_at } : {}) })),
    statuses: (statuses.status === 'fulfilled' ? statuses.value : []).map((x) => ({ context: x.context, state: x.state, ...(x.target_url ? { url: x.target_url } : {}), ...(x.description ? { description: x.description } : {}) })),
    ...why,
  };
}

/** What a pull request's reviews decide (issue #1072): the latest review of each reviewer that approves, asks for changes or was dismissed. */
export function reviewDecision(reviews: readonly { author: string; state: string }[]): 'approved' | 'changes_requested' | 'none' {
  const latest = new Map<string, string>();
  for (const r of reviews) if (r.state === 'approved' || r.state === 'changes_requested' || r.state === 'dismissed') latest.set(r.author, r.state);
  const states = [...latest.values()];
  return states.includes('changes_requested') ? 'changes_requested' : states.includes('approved') ? 'approved' : 'none';
}

/** A pull request's reviews (issue #1072), oldest first, with what they decide. A review not yet sent (pending) is not one. */
async function pullReviews(req: Request, token: string, r: { repo: string; number: number }, url: string): Promise<ProxyResult> {
  const read = await paginate<RestReview>(req, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', { ...splitRepo(r.repo), pull_number: r.number, per_page: 100 }, `token ${token}`, (d) => d as RestReview[]);
  const reviews = read.filter((x) => x.state !== 'PENDING').map((x) => ({
    id: x.id, author: x.user?.login ?? '', state: x.state.toLowerCase(), body: x.body ?? '', ...(x.submitted_at ? { submittedAt: x.submitted_at } : {}), ...(x.html_url ? { url: x.html_url } : {}),
  }));
  return { number: r.number, url, decision: reviewDecision(reviews), reviews };
}

/** A check run's conclusion that fails the checks (as the follow's rollup, src/sources/github/closer.ts). */
const FAILED_RUN = new Set(['failure', 'timed_out', 'startup_failure']);

/**
 * A commit's checks from its check runs (issue #1072, `runChecks`): failing once one failed, pending while one runs, none with no run.
 * GitHub refusing them (403, 404: the connection may not read checks, issue #855) is `unknown`, never a failure of the read,
 * and says why and the fix (`checksWhy`, issue #1279).
 */
async function checksOf(req: Request, headers: Record<string, string>, repo: string, sha: string): Promise<Pick<PullRequestStatus, 'checks' | 'failedChecks' | 'checksWhy'>> {
  try {
    return runChecks(((await req('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', { ...splitRepo(repo), ref: sha, per_page: 100, headers })).data as { check_runs?: RestCheckRun[] }).check_runs ?? []);
  } catch (err) {
    if (refusedRead(err)) return { checks: 'unknown', failedChecks: [], checksWhy: checksLack(ACCOUNT_CONNECTION, ['checks']) };
    throw err;
  }
}

/** A commit's checks from its check runs, the newest run of each check only (issue #2129): a newer run supersedes an older one. */
export function runChecks(all: RestCheckRun[]): Pick<PullRequestStatus, 'checks' | 'failedChecks'> {
  const runs = newestRuns(all, (r) => r.name, (r) => r.id);
  const failed = runs.filter((r) => FAILED_RUN.has(r.conclusion ?? ''));
  const failedChecks = failed.map((r) => ({ name: r.name, ...(r.html_url ?? r.details_url ? { url: (r.html_url ?? r.details_url)! } : {}) }));
  return { checks: runs.length === 0 ? 'none' : failed.length > 0 ? 'failing' : runs.some((r) => r.status !== 'completed') ? 'pending' : 'passing', failedChecks };
}

/** Where a pull request stands, read on GitHub (issue #1072): what `pr status` answers for one the hopper does not know. */
async function pullStatus(req: Request, headers: Record<string, string>, repo: string, number: number): Promise<PullRequestStatus> {
  const d = (await req('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...splitRepo(repo), pull_number: number, headers })).data as RestPull;
  const state = d.merged === true ? 'merged' : d.state === 'closed' ? 'closed' : 'open';
  const checks = d.head.sha ? await checksOf(req, headers, repo, d.head.sha) : { checks: 'unknown' as const, failedChecks: [] };
  return {
    number: d.number, url: d.html_url, state, draft: d.draft === true,
    mergeable: d.mergeable === true ? 'mergeable' : d.mergeable === false ? 'conflicts' : 'unknown', ...checks, base: d.base.ref, head: d.head.ref,
  };
}

async function call(req: Request, token: string, r: ProxyRequest, webOrigin: string, filed: FiledWith = {}): Promise<ProxyResult> {
  const headers = { authorization: `token ${token}` };
  const at = splitRepo(r.repo);
  switch (r.op) {
    case 'pr.diff': return pullDiff(req, token, r, `${webOrigin}/${r.repo}/pull/${r.number}`);
    case 'pr.checks': return pullChecks(req, token, r);
    case 'pr.reviews': return pullReviews(req, token, r, `${webOrigin}/${r.repo}/pull/${r.number}`);
    case 'pr.commits': {
      const commits = await paginate<RestCommit>(req, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', { ...at, pull_number: r.number, per_page: 100 }, `token ${token}`, (d) => d as RestCommit[]);
      return {
        number: r.number, url: `${webOrigin}/${r.repo}/pull/${r.number}`,
        commits: commits.map((c) => ({ sha: c.sha, message: c.commit.message, author: c.author?.login ?? c.commit.author?.name ?? '', ...(c.commit.author?.date ? { date: c.commit.author.date } : {}) })),
      };
    }
    case 'issue.comments': {
      const comments = await paginate<RestComment>(req, 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...at, issue_number: r.number, per_page: 100 }, `token ${token}`, (d) => d as RestComment[]);
      return {
        number: r.number, url: `${webOrigin}/${r.repo}/issues/${r.number}`,
        comments: comments.map((c) => ({ id: c.id, author: c.user?.login ?? '', createdAt: c.created_at, body: c.body ?? '', url: c.html_url })),
      };
    }
    case 'repo.view': return { ...(await readRepo(req, headers, r.repo)) };
    case 'repo.fork': return fork(req, headers, r.repo);
    case 'check.log': return checkLog(req, token, webOrigin, r.repo, r.number);
    case 'run.list': return listRuns(req, token, webOrigin, r);
    case 'run.view': return viewRun(req, token, webOrigin, r);
    case 'issue.create': {
      const routed = { ...(filed.labels ? { labels: filed.labels } : {}), ...(filed.assignees ? { assignees: filed.assignees } : {}) };
      const d = await fileAssignedIssue(req, headers, r.repo, { title: r.title, body: r.body, ...routed });
      if (filed.subIssueOf) passProxyKillPoint(r.op, 'before-link'); return { number: d.number, url: d.url, ...(d.unassigned ? { unassigned: d.unassigned } : {}), ...(filed.subIssueOf ? await linkSubIssue(req, headers, filed.subIssueOf, d.id) : {}) };
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
    case 'pr.status': return { ...(await pullStatus(req, headers, r.repo, r.number)) };
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
    case 'pr.edit': {
      const changed = { ...(r.title !== undefined ? { title: r.title } : {}), ...(r.body !== undefined ? { body: r.body } : {}) };
      const d = (await req('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...at, pull_number: r.number, ...changed, headers })).data as RestPull;
      return { number: d.number, url: d.html_url, title: d.title, state: d.state };
    }
    case 'pr.close': {
      const d = (await req('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...at, pull_number: r.number, state: 'closed', headers })).data as RestPull;
      return { number: d.number, url: d.html_url, state: d.state, merged: d.merged === true };
    }
    case 'pr.create': {
      const base = r.base ?? ((await req('GET /repos/{owner}/{repo}', { ...at, headers })).data as { default_branch: string }).default_branch;
      const d = (await req('POST /repos/{owner}/{repo}/pulls', { ...at, head: r.head, base, title: r.title, body: r.body, headers })).data as RestPull;
      return { number: d.number, url: d.html_url, head: d.head.ref, base: d.base.ref };
    }
  }
}

/** GitHub's message for a failed call to `what`, as the job reads it. */
export function messageOf(err: unknown, what: string): string {
  const e = err as { message?: unknown; response?: { data?: { message?: unknown; errors?: { message?: unknown }[] } } };
  const detail = e.response?.data?.errors?.map((x) => (typeof x.message === 'string' ? x.message : '')).filter(Boolean).join('; ');
  const message = typeof e.response?.data?.message === 'string' ? e.response.data.message : typeof e.message === 'string' ? e.message : String(err);
  return `GitHub answered ${statusOf(err) ?? 'no status'} to ${what}: ${message}${detail ? ` (${detail})` : ''}`;
}

/**
 * GitHub's failure as the job reads it; a refusal of the app says what it needs and the fix (issue #1279, as #1351); for a
 * check's log (issue #993), why the hopper could not read it.
 */
function errorOf(err: unknown, r: ProxyRequest): ProxyGitHubError {
  if (r.op !== 'check.log') {
    const message = messageOf(err, `${r.op} on ${r.repo}`);
    const why = err instanceof ProxyGitHubError || !notAccessible(message) ? message : explained(message, permissionsOfError(err));
    return new ProxyGitHubError(why, statusOf(err));
  }
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

export function createProxyApi(o: { apiUrl: string; kind?: GitHubCallKind } & TokenSource): ProxyApi {
  // A running job's requests count as its own kind (issue #985); a person's read of a job's pull request (issue #1169) as a job's other read.
  const req = makeRequest(o.apiUrl, undefined, { kind: o.kind ?? 'job' });
  const withToken = tokenCaller(o);
  const openPull = (repo: string, branch: string): Promise<RestPull | undefined> => withToken(
    async (token) => ((await req('GET /repos/{owner}/{repo}/pulls', { ...splitRepo(repo), state: 'open', head: `${repo.split('/')[0]!}:${branch}`, per_page: 1, headers: { authorization: `token ${token}` } })).data as RestPull[])[0],
    (err) => new ProxyGitHubError(messageOf(err, `the pull request of ${repo} ${branch}`), statusOf(err)),
  );
  return {
    perform: (r, filed) => withToken((token) => call(req, token, r, webOriginOf(o.apiUrl), filed), (err) => errorOf(err, r)),
    find: (r, postKey, since, login, filed = {}) => withToken((token) => findFiled(req, token, r, { postKey, since, login, ...(filed.subIssueOf ? { subIssueOf: filed.subIssueOf } : {}) }, linkSubIssue), (err) => errorOf(err, r)),
    repo: (repo) => withToken(
      (token) => readRepo(req, { authorization: `token ${token}` }, repo),
      (err) => new ProxyGitHubError(`GitHub answered ${statusOf(err) ?? 'no status'} reading ${repo}: ${(err as Error).message}`, statusOf(err)),
    ),
    head: (repo, ref) => withToken(
      async (token) => ((await req('GET /repos/{owner}/{repo}/commits/{ref}', { ...splitRepo(repo), ref, headers: { authorization: `token ${token}` } })).data as { sha: string }).sha,
      (err) => new ProxyGitHubError(messageOf(err, `the head of ${repo} ${ref}`), statusOf(err)),
    ),
    pullRequestBase: async (repo, branch) => (await openPull(repo, branch))?.base.ref,
    pullRequestOf: async (repo, branch) => { const p = await openPull(repo, branch); return p && { number: p.number, body: p.body ?? '' }; },
  };
}
