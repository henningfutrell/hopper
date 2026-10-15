// The pull requests merged into a branch (issue #1337), read by the connected account's adapter: the newest
// 50 by their last update, each with its text. What tells an issue whose work merged into the landing branch, which GitHub
// does not close, and whose timeline may show no cross-reference of the merge. NOT_FOUND and FORBIDDEN are permanent; any
// other error is transient.
import { GitHubApiError } from '../api.ts';
import type { MergedPullRequest } from '../api.ts';
import type { Request } from './http.ts';
import { splitRepo } from './http.ts';

export const MERGED_INTO_QUERY = `query($owner: String!, $name: String!, $base: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(baseRefName: $base, states: [MERGED], first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { url number createdAt mergedAt body } }
  }
}`;

interface GqlMerged { url?: string; number?: number; createdAt?: string; mergedAt?: string | null; body?: string }
interface GqlBody {
  data?: { repository?: { pullRequests?: { nodes?: (GqlMerged | null)[] } } | null } | null;
  errors?: { type?: string; message?: string }[];
}

const PERMANENT_TYPES = new Set(['NOT_FOUND', 'FORBIDDEN']);

export function mergedPullRequestsFrom(body: unknown, what: string): MergedPullRequest[] {
  const r = (body ?? {}) as GqlBody;
  if (r.errors?.length) {
    throw new GitHubApiError(`${what}: ${r.errors.map((e) => e.message ?? e.type ?? 'error').join('; ')}`, r.errors.some((e) => PERMANENT_TYPES.has(e.type ?? '')));
  }
  return (r.data?.repository?.pullRequests?.nodes ?? []).flatMap((n) => n?.url && n.number !== undefined && n.createdAt && n.mergedAt
    ? [{ url: n.url, number: n.number, createdAt: n.createdAt, mergedAt: n.mergedAt, body: n.body ?? '' }] : []);
}

export async function mergedPullRequestsInto(req: Request, token: string, repo: string, base: string): Promise<MergedPullRequest[]> {
  const { owner, repo: name } = splitRepo(repo);
  const r = await req('POST /graphql', { query: MERGED_INTO_QUERY, variables: { owner, name, base }, headers: { authorization: `token ${token}` } });
  return mergedPullRequestsFrom(r.data, `pull requests merged into ${base} of ${repo}`);
}
