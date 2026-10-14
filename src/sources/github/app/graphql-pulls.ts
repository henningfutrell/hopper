// The in-motion cycle's batched reads (issue #985, design.md "Batched GraphQL reads"), shared by the App and the connected
// account adapters. `pullRequestStates`: the pull requests the jobs follow and their issues, each an alias in a request —
// `p0: repository(owner: $o0, name: $n0) { pr: pullRequest(number: 7) { … } issue: issue(number: 3) { … } }` —, at most
// PULLS_MAX to a request. `openPullRequestsIn`: the open pull requests of many repositories, for reconciling, each
// repository an alias, at most OPEN_PULLS_REPOS_MAX to a request, newest 100 each as `openPullRequests` reads one. Neither
// pages: one pull request is one node, and reconciling reads no more than the newest 100, as before. An error on one alias
// fails only its pull request or repository; checks the credential may not read are `unknown`; an error on the issue
// leaves the pull request without it. A request that fails, or an error that names no alias, throws: the cycle asks again.
import type { BranchPullRequest, OpenPullRequestsIn, PullRequestRef, PullRequestState, PullRequestStates } from '../api.ts';
import { pullKey } from '../api.ts';
import { rollupChecks } from '../closer.ts';
import type { Request } from './http.ts';
import { splitRepo } from './http.ts';

/** The most pull requests in one request. */
export const PULLS_MAX = 50;
/** The most repositories in one request of open pull requests: 25 × 100 pull requests. */
export const OPEN_PULLS_REPOS_MAX = 25;

const PULL = 'state isDraft mergeable createdAt body headRefName headRefOid baseRefName commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }';
const OPEN_PULL = 'url createdAt isDraft mergeable body headRefName';

interface GqlPull {
  state?: string; isDraft?: boolean; mergeable?: string; createdAt?: string; body?: string; headRefName?: string; headRefOid?: string; baseRefName?: string;
  commits?: { nodes?: ({ commit?: { committedDate?: string; statusCheckRollup?: { state?: string } | null } | null } | null)[] } | null;
}
interface GqlIssue { state?: string; stateReason?: string | null; updatedAt?: string }
interface GqlOpenPull { url?: string; createdAt?: string; isDraft?: boolean; mergeable?: string; body?: string; headRefName?: string }
interface GqlError { message?: string; type?: string; path?: (string | number)[] }
interface GqlBody<T> { data?: Record<string, T | null> | null; errors?: GqlError[] }

const STATES: Record<string, PullRequestState['state']> = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };

/** Each repository of `repos` once, its owner and name as variables `$o<i>`, `$n<i>`. */
function repoVariables(repos: string[]): { params: string[]; variables: Record<string, unknown> } {
  const params: string[] = [];
  const variables: Record<string, unknown> = {};
  repos.forEach((repo, i) => {
    const { owner, repo: name } = splitRepo(repo);
    Object.assign(variables, { [`o${i}`]: owner, [`n${i}`]: name });
    params.push(`$o${i}: String!`, `$n${i}: String!`);
  });
  return { params, variables };
}

/** One request; the errors by alias, after it throws for an error that names none. */
async function ask<T>(req: Request, token: string, query: string, variables: Record<string, unknown>): Promise<{ data: Record<string, T | null>; errors: GqlError[] }> {
  const body = ((await req('POST /graphql', { query, variables, headers: { authorization: `token ${token}` } })).data ?? {}) as GqlBody<T>;
  const unnamed = (body.errors ?? []).filter((e) => !e.path?.length);
  if (!body.data || unnamed.length) throw new Error(`GraphQL: ${(unnamed.length ? unnamed : body.errors ?? []).map((e) => e.message ?? '').join('; ') || 'no data'}`);
  return { data: body.data, errors: body.errors ?? [] };
}

function stateFrom(p: GqlPull, issue: GqlIssue | null | undefined, checksUnknown: boolean): PullRequestState | undefined {
  const state = STATES[p.state ?? ''];
  if (!state || !p.createdAt) return undefined;
  const commit = p.commits?.nodes?.at(-1)?.commit;
  const checks = checksUnknown ? 'unknown' : rollupChecks(commit?.statusCheckRollup);
  const issueState = issue?.state === 'OPEN' ? 'open' : issue?.state === 'CLOSED' ? 'closed' : undefined;
  return {
    state, isDraft: p.isDraft === true, mergeable: p.mergeable ?? 'UNKNOWN', createdAt: p.createdAt, body: p.body ?? '',
    ...(commit?.committedDate ? { headCommittedAt: commit.committedDate } : {}), ...(p.headRefOid ? { headOid: p.headRefOid } : {}),
    ...(p.headRefName ? { headRef: p.headRefName } : {}), ...(p.baseRefName ? { base: p.baseRefName } : {}), ...(checks ? { checks } : {}),
    ...(issueState ? { issue: { state: issueState, ...(issue?.stateReason ? { stateReason: issue.stateReason.toLowerCase() } : {}), updatedAt: issue?.updatedAt ?? '' } } : {}),
  };
}

/** The pull requests `refs` and their issues, with `token`. */
export async function pullRequestStates(req: Request, token: string, refs: PullRequestRef[]): Promise<PullRequestStates> {
  const out: PullRequestStates = { pulls: new Map(), errors: new Map() };
  for (let at = 0; at < refs.length; at += PULLS_MAX) {
    const chunk = refs.slice(at, at + PULLS_MAX);
    const { params, variables } = repoVariables(chunk.map((r) => r.repo));
    const fields = chunk.map((r, i) =>
      `p${i}: repository(owner: $o${i}, name: $n${i}) { pr: pullRequest(number: ${Math.trunc(r.pullRequest)}) { ${PULL} } issue: issue(number: ${Math.trunc(r.issue)}) { state stateReason updatedAt } }`);
    const { data, errors } = await ask<{ pr?: GqlPull | null; issue?: GqlIssue | null }>(req, token, `query(${params.join(', ')}) {\n${fields.join('\n')}\n}`, variables);
    chunk.forEach((r, i) => {
      const alias = `p${i}`;
      const mine = errors.filter((e) => e.path![0] === alias);
      const failed = mine.find((e) => e.path!.length === 1 || e.path![1] === 'pr' && e.path!.at(-1) !== 'statusCheckRollup');
      const pr = data[alias]?.pr;
      const state = !failed && pr ? stateFrom(pr, data[alias]?.issue, mine.some((e) => e.path!.at(-1) === 'statusCheckRollup')) : undefined;
      if (state) out.pulls.set(pullKey(r.repo, r.pullRequest), state);
      else out.errors.set(pullKey(r.repo, r.pullRequest), failed?.message ?? 'not answered');
    });
  }
  return out;
}

/** The open pull requests of `repos`, newest first, with `token`. */
export async function openPullRequestsIn(req: Request, token: string, repos: string[]): Promise<OpenPullRequestsIn> {
  const out: OpenPullRequestsIn = { repos: new Map(), repoErrors: new Map() };
  const unique = [...new Set(repos)];
  for (let at = 0; at < unique.length; at += OPEN_PULLS_REPOS_MAX) {
    const chunk = unique.slice(at, at + OPEN_PULLS_REPOS_MAX);
    const { params, variables } = repoVariables(chunk);
    const fields = chunk.map((_, i) =>
      `u${i}: repository(owner: $o${i}, name: $n${i}) { pullRequests(states: OPEN, first: 100, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${OPEN_PULL} } } }`);
    const { data, errors } = await ask<{ pullRequests?: { nodes?: (GqlOpenPull | null)[] } | null }>(req, token, `query(${params.join(', ')}) {\n${fields.join('\n')}\n}`, variables);
    chunk.forEach((repo, i) => {
      const alias = `u${i}`;
      const failed = errors.find((e) => e.path![0] === alias && e.path!.length <= 2);
      const answer = data[alias];
      if (failed || !answer) { out.repoErrors.set(repo, failed?.message ?? 'not answered'); return; }
      out.repos.set(repo, (answer.pullRequests?.nodes ?? []).flatMap((n): BranchPullRequest[] => (n?.url && n.createdAt && n.headRefName
        ? [{ url: n.url, createdAt: n.createdAt, isDraft: n.isDraft === true, conflicting: n.mergeable === 'CONFLICTING', headRef: n.headRefName, body: n.body ?? '' }] : [])));
    });
  }
  return out;
}
