// The GitHub calls of head branch deletion (issue #2914): a pull request and a branch as a deletion reads them, the delete,
// and the sweep's listing — a page of branches, each with the pull requests whose head it is (GraphQL `refs`, one request per
// hundred branches). NOT_FOUND and FORBIDDEN are permanent; any other GraphQL error is transient.
import type { BranchFacts, BranchRef, HeadBranchPull } from '../../../domain/head-branches.ts';
import { GitHubApiError, type BranchRefPage } from '../api.ts';
import { splitRepo, statusOf, type Request } from './http.ts';

const PULL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequest(number: $number) { url state mergedAt closedAt headRefName headRefOid isCrossRepository }
  }
}`;

const OPEN_QUERY = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    heads: pullRequests(headRefName: $branch, states: [OPEN], first: 100) { nodes { isCrossRepository } }
    bases: pullRequests(baseRefName: $branch, states: [OPEN], first: 1) { totalCount }
  }
}`;

const REFS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    refs(refPrefix: "refs/heads/", first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { name target { oid } associatedPullRequests(first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { url state headRefOid isCrossRepository mergedAt closedAt } } }
    }
  }
}`;

interface GqlPull { url: string; state: string; mergedAt?: string | null; closedAt?: string | null; headRefName?: string; headRefOid: string; isCrossRepository: boolean }
interface GqlAnswer<T> { data?: { repository?: T | null } | null; errors?: { type?: string; message?: string }[] }

const PERMANENT_TYPES = new Set(['FORBIDDEN']);

const stateOf = (s: string): HeadBranchPull['state'] => (s === 'MERGED' ? 'merged' : s === 'CLOSED' ? 'closed' : 'open');
const endedAt = (p: GqlPull): { endedAt: string } | Record<string, never> => { const at = p.mergedAt ?? p.closedAt; return at ? { endedAt: at } : {}; };

/** The repository of a GraphQL answer. An error that says only that a thing is not there leaves the rest. */
function repositoryOf<T>(body: unknown, what: string): T | undefined {
  const r = (body ?? {}) as GqlAnswer<T>;
  const errors = (r.errors ?? []).filter((e) => e.type !== 'NOT_FOUND');
  if (errors.length) throw new GitHubApiError(`${what}: ${errors.map((e) => e.message ?? e.type ?? 'error').join('; ')}`, errors.some((e) => PERMANENT_TYPES.has(e.type ?? '')));
  return r.data?.repository ?? undefined;
}

export async function headBranchPull(req: Request, token: string, repo: string, number: number): Promise<HeadBranchPull | undefined> {
  const { owner, repo: name } = splitRepo(repo);
  const r = await req('POST /graphql', { query: PULL_QUERY, variables: { owner, name, number }, headers: { authorization: `token ${token}` } });
  const d = repositoryOf<{ defaultBranchRef?: { name: string } | null; pullRequest?: GqlPull | null }>(r.data, `pull request ${repo}#${number}`);
  const p = d?.pullRequest;
  if (!p?.headRefName || !d?.defaultBranchRef) return undefined;
  return { url: p.url, state: stateOf(p.state), headRef: p.headRefName, headOid: p.headRefOid, fork: p.isCrossRepository, defaultBranch: d.defaultBranchRef.name, ...endedAt(p) };
}

export async function branchFacts(req: Request, token: string, repo: string, branch: string): Promise<BranchFacts | undefined> {
  const headers = { authorization: `token ${token}` };
  const at = await req('GET /repos/{owner}/{repo}/branches/{branch}', { ...splitRepo(repo), branch, headers }).catch((e: unknown) => {
    if (statusOf(e) === 404) return undefined;
    throw e;
  });
  if (!at) return undefined;
  const d = at.data as { commit: { sha: string }; protected?: boolean };
  const { owner, repo: name } = splitRepo(repo);
  const r = await req('POST /graphql', { query: OPEN_QUERY, variables: { owner, name, branch }, headers });
  const open = repositoryOf<{ heads?: { nodes?: ({ isCrossRepository?: boolean } | null)[] }; bases?: { totalCount?: number } }>(r.data, `pull requests of the branch ${branch} of ${repo}`);
  // Read nothing, say nothing is safe: the row is tried again.
  if (!open) throw new GitHubApiError(`pull requests of the branch ${branch} of ${repo}: no answer`, false);
  return { tip: d.commit.sha, protected: d.protected ?? false, openHeads: (open.heads?.nodes ?? []).filter((n) => n && !n.isCrossRepository).length, openBases: open.bases?.totalCount ?? 0 };
}

/** A 404 is a branch already gone; a 422 is that too, or GitHub's rules keeping it: nothing more to do either way. */
export async function deleteBranch(req: Request, token: string, repo: string, branch: string): Promise<void> {
  await req('DELETE /repos/{owner}/{repo}/git/refs/{ref}', { ...splitRepo(repo), ref: `heads/${branch}`, headers: { authorization: `token ${token}` } }).catch((e: unknown) => {
    if (statusOf(e) !== 404 && statusOf(e) !== 422) throw e;
  });
}

export async function branchRefs(req: Request, token: string, repo: string, after?: string): Promise<BranchRefPage> {
  const { owner, repo: name } = splitRepo(repo);
  const r = await req('POST /graphql', { query: REFS_QUERY, variables: { owner, name, ...(after ? { after } : {}) }, headers: { authorization: `token ${token}` } });
  type Node = { name: string; target?: { oid?: string } | null; associatedPullRequests?: { nodes?: (GqlPull | null)[] } };
  const d = repositoryOf<{ defaultBranchRef?: { name: string } | null; refs?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: (Node | null)[] } }>(r.data, `branches of ${repo}`);
  // No default branch said: a repository with no commits, or an answer the hopper cannot judge. It lists nothing.
  if (!d?.defaultBranchRef) return { refs: [], defaultBranch: '' };
  const refs = (d.refs?.nodes ?? []).flatMap((n): BranchRef[] => n?.target?.oid ? [{
    name: n.name, tip: n.target.oid,
    pulls: (n.associatedPullRequests?.nodes ?? []).flatMap((p) => p ? [{ url: p.url, state: stateOf(p.state), headOid: p.headRefOid, fork: p.isCrossRepository, ...endedAt(p) }] : []),
  }] : []);
  const next = d.refs?.pageInfo?.hasNextPage ? d.refs.pageInfo.endCursor ?? undefined : undefined;
  return { refs, defaultBranch: d.defaultBranchRef.name, ...(next ? { after: next } : {}) };
}
