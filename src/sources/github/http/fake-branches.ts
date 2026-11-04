// A repository's branches in the node:http fake GitHub (issue #2914, head branch deletion). A pull request entry's `pull` names
// its head and base. Test support only: the daemon never imports it.
import type { FakeCtx, FakeReply, FakeReq } from './fake-routes.ts';
import type { FakeIssue, FakeRepo } from './fake-state.ts';

const pullsOf = (repo: FakeRepo): FakeIssue[] => [...repo.issues.values()].filter((i) => i.pullRequest);
const url = (repo: FakeRepo, n: number): string => `https://github.com/${repo.owner}/${repo.name}/pull/${n}`;
const stateOf = (i: FakeIssue): string => i.pull?.state ?? 'OPEN';
const oidOf = (i: FakeIssue): string => i.pull?.headOid ?? `h${i.number}`;
const refOf = (i: FakeIssue): string => i.pull?.headRef ?? `issue-${i.number}`;
const ended = (i: FakeIssue) => ({ mergedAt: stateOf(i) === 'MERGED' ? i.updatedAt : null, closedAt: stateOf(i) === 'OPEN' ? null : i.updatedAt });
const pullNode = (repo: FakeRepo, i: FakeIssue) => ({ url: url(repo, i.number), state: stateOf(i), headRefName: refOf(i), headRefOid: oidOf(i), isCrossRepository: false, ...ended(i) });

/** `GET …/branches/{branch}` and `DELETE …/git/refs/heads/{branch}`; undefined: another route. */
export function branchRoutes(req: FakeReq, repo: FakeRepo, encoded: string): FakeReply | undefined {
  // The client encodes a ref's slashes.
  const rest = decodeURIComponent(encoded);
  const read = /^\/branches\/(.+)$/.exec(rest);
  if (req.method === 'GET' && read) {
    const b = repo.branches.get(read[1]!);
    return b ? { status: 200, body: { name: read[1]!, commit: { sha: b.sha }, protected: b.protected ?? false } } : { status: 404, body: { message: 'Branch not found' } };
  }
  const del = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
  if (req.method === 'DELETE' && del) {
    return repo.branches.delete(del[1]!) ? { status: 204 } : { status: 422, body: { message: 'Reference does not exist' } };
  }
  return undefined;
}

interface Gql { query?: string; variables?: { owner?: string; name?: string; number?: number; branch?: string; after?: string | null } }

/** The GraphQL reads of head branch deletion; undefined: another query. */
export function branchQueries(ctx: FakeCtx, b: Gql): FakeReply | undefined {
  const q = b.query ?? '';
  if (!/headRefOid isCrossRepository|heads: pullRequests/.test(q)) return undefined;
  const repo = ctx.state.repos.get(`${b.variables?.owner}/${b.variables?.name}`);
  if (!repo) return { status: 200, body: { data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] } };
  const defaultBranchRef = { name: 'main' };
  if (/\$number: Int!/.test(q)) {
    const i = repo.issues.get(Number(b.variables?.number));
    return { status: 200, body: { data: { repository: { defaultBranchRef, pullRequest: i?.pullRequest ? pullNode(repo, i) : null } } } };
  }
  if (/\$branch: String!/.test(q)) {
    const open = pullsOf(repo).filter((i) => stateOf(i) === 'OPEN');
    const heads = open.filter((i) => refOf(i) === b.variables?.branch).map(() => ({ isCrossRepository: false }));
    return { status: 200, body: { data: { repository: { heads: { nodes: heads }, bases: { totalCount: open.filter((i) => i.pull?.base === b.variables?.branch).length } } } } };
  }
  const nodes = [...repo.branches].map(([name, at]) => ({
    name, target: { oid: at.sha },
    associatedPullRequests: { nodes: pullsOf(repo).filter((i) => refOf(i) === name).map((i) => pullNode(repo, i)) },
  }));
  return { status: 200, body: { data: { repository: { defaultBranchRef, refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } };
}
