// Repository listings (issue #985, design.md "Repository listings"), shared by the App and the connected account adapters:
// the open issues and pull requests of many repositories that carry one of the source's labels, with one token, in as few
// GraphQL requests as GitHub allows. Each repository is an alias in a request — `r0: repository(owner: $o0, name: $n0)
// { issues(…) pullRequests(…) }` —, at most LISTING_REPOS_MAX to a request. A repository whose issues or pull requests
// have another page is asked again, alone with that connection and its cursor, beside the others that have one; the rest
// are done after the first request. An error on a repository or its connection fails only that repository (repoErrors);
// an error on one field of one item leaves the item listed without it. A request that fails, or an error that names no
// repository, throws: the sync asks again.
import type { ListedItem, RepoListing } from '../../../domain/github-listing.ts';
import { rollupChecks } from '../closer.ts';
import type { Request } from './http.ts';
import { splitRepo } from './http.ts';

/** The most repositories in one request: 25 × two connections of LISTING_PAGE items stays well under GitHub's node limit. */
export const LISTING_REPOS_MAX = 25;
/** Items per connection per page. */
export const LISTING_PAGE = 50;
/** A repository's pages at most, as `paginate`'s MAX_PAGES. */
const MAX_PAGES = 100;

const ITEM = 'number url title updatedAt author { login } labels(first: 30) { nodes { name } } assignees(first: 10) { nodes { login } }';
const PULL = `${ITEM} isDraft headRefName headRefOid baseRefName mergeable commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

type Connection = 'issues' | 'pullRequests';
/** One repository's part of a request: the connections it asks, each from its cursor (null: the first page). */
interface Ask { repo: string; owner: string; name: string; after: Partial<Record<Connection, string | null>> }

interface GqlNode {
  number?: number; url?: string; title?: string; updatedAt?: string; author?: { login?: string } | null;
  labels?: { nodes?: ({ name?: string } | null)[] } | null; assignees?: { nodes?: ({ login?: string } | null)[] } | null;
  isDraft?: boolean; headRefName?: string; headRefOid?: string; baseRefName?: string; mergeable?: string;
  commits?: { nodes?: ({ commit?: { statusCheckRollup?: { state?: string } | null } | null } | null)[] } | null;
}
interface GqlConnection { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: (GqlNode | null)[] }
interface GqlError { message?: string; type?: string; path?: (string | number)[] }
interface GqlBody { data?: Record<string, Partial<Record<Connection, GqlConnection>> | null> | null; errors?: GqlError[] }

function listingQuery(asks: Ask[], labels: string[]): { query: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = { labels };
  const params = ['$labels: [String!]'];
  const fields = asks.map((a, i) => {
    Object.assign(variables, { [`o${i}`]: a.owner, [`n${i}`]: a.name });
    params.push(`$o${i}: String!`, `$n${i}: String!`);
    const parts = (['issues', 'pullRequests'] as const).filter((c) => c in a.after).map((c) => {
      const cursor = `${c === 'issues' ? 'ai' : 'ap'}${i}`;
      variables[cursor] = a.after[c];
      params.push(`$${cursor}: String`);
      return `${c}(states: OPEN, labels: $labels, first: ${LISTING_PAGE}, after: $${cursor}) { pageInfo { hasNextPage endCursor } nodes { ${c === 'issues' ? ITEM : PULL} } }`;
    });
    return `r${i}: repository(owner: $o${i}, name: $n${i}) { ${parts.join(' ')} }`;
  });
  return { query: `query(${params.join(', ')}) {\n${fields.join('\n')}\n}`, variables };
}

const names = <T>(c: { nodes?: (T | null)[] } | null | undefined, pick: (n: T) => string | undefined): string[] =>
  (c?.nodes ?? []).map((n) => (n ? pick(n) ?? '' : '')).filter((s) => s !== '');

function itemFrom(repo: string, n: GqlNode, pull: boolean, checksUnknown: boolean): ListedItem | undefined {
  if (typeof n.number !== 'number' || !n.url) return undefined;
  const item: ListedItem = {
    repo, number: n.number, kind: pull ? 'pull' : 'issue', url: n.url, title: n.title ?? '', author: n.author?.login ?? '',
    labels: names(n.labels, (l) => l.name), assignees: names(n.assignees, (a) => a.login), updatedAt: n.updatedAt ?? '',
  };
  if (!pull) return item;
  const rollup = n.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const checks = checksUnknown ? 'unknown' : rollup ? rollupChecks(rollup) ?? 'unknown' : 'none';
  return { ...item, pull: { isDraft: n.isDraft ?? false, headRef: n.headRefName ?? '', headOid: n.headRefOid ?? '', base: n.baseRefName ?? '', mergeable: n.mergeable ?? 'UNKNOWN', checks } };
}

/** The listing of `repos` (owner/name), with `token`: their open issues and pull requests that carry one of `labels`. */
export async function listRepos(req: Request, token: string, repos: string[], labels: string[]): Promise<RepoListing> {
  const out: RepoListing = { repos: new Map(), repoErrors: new Map() };
  const pages = new Map<string, number>();
  let asks: Ask[] = [...new Set(repos)].map((repo) => {
    const { owner, repo: name } = splitRepo(repo);
    out.repos.set(repo, []);
    return { repo, owner, name, after: { issues: null, pullRequests: null } };
  });
  while (asks.length > 0) {
    const next: Ask[] = [];
    for (let i = 0; i < asks.length; i += LISTING_REPOS_MAX) {
      const chunk = asks.slice(i, i + LISTING_REPOS_MAX);
      const body = (await req('POST /graphql', { ...listingQuery(chunk, labels), headers: { authorization: `token ${token}` } })).data as GqlBody;
      next.push(...takeAnswer(out, chunk, body ?? {}));
    }
    asks = next.filter((a) => {
      const n = (pages.get(a.repo) ?? 1) + 1;
      pages.set(a.repo, n);
      return n <= MAX_PAGES;
    });
  }
  return out;
}

/** Puts one request's answer into `out`; answers the asks for the next pages. */
function takeAnswer(out: RepoListing, chunk: Ask[], body: GqlBody): Ask[] {
  const unnamed = (body.errors ?? []).filter((e) => !e.path?.length);
  if (!body.data || unnamed.length) throw new Error(`GraphQL: ${(unnamed.length ? unnamed : body.errors ?? []).map((e) => e.message ?? '').join('; ') || 'no data'}`);
  const failed = new Map<string, string>();
  const checksUnknown = new Set<string>();
  for (const e of body.errors ?? []) {
    const [alias, connection, , index] = e.path!;
    if (e.path!.length <= 2) failed.set(String(alias), e.message ?? 'not answered');
    else if (e.path!.at(-1) === 'statusCheckRollup') checksUnknown.add(`${String(alias)}/${String(connection)}/${String(index)}`);
  }
  const next: Ask[] = [];
  chunk.forEach((a, i) => {
    const alias = `r${i}`;
    const answer = body.data![alias];
    const error = failed.get(alias) ?? (answer ? undefined : 'not answered');
    if (error !== undefined) {
      out.repos.delete(a.repo);
      out.repoErrors.set(a.repo, error);
      return;
    }
    const after: Ask['after'] = {};
    for (const c of Object.keys(a.after) as Connection[]) {
      const conn = answer![c];
      (conn?.nodes ?? []).forEach((n, k) => {
        const item = n ? itemFrom(a.repo, n, c === 'pullRequests', checksUnknown.has(`${alias}/${c}/${k}`)) : undefined;
        if (item) out.repos.get(a.repo)!.push(item);
      });
      if (conn?.pageInfo?.hasNextPage && conn.pageInfo.endCursor) after[c] = conn.pageInfo.endCursor;
    }
    if (Object.keys(after).length) next.push({ ...a, after });
  });
  return next;
}
