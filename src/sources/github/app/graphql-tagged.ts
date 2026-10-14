// Tagged items (issue #1141, design.md "Tagged items"): the open issues and pull requests of the job repositories where a
// login is a requested reviewer, is @mentioned, or is assigned, from GitHub's issue search, in as few GraphQL requests as the
// search allows. One search per reason and per group of repositories: GitHub takes a search query of at most
// SEARCH_QUERY_MAX characters, so the `repo:` qualifiers are grouped to fit. Each search is an alias in a request, at most
// SEARCHES_MAX to a request, and reads its first TAGGED_PAGE hits only. A request that fails, or an error on a search,
// throws: the sync reads again. An error on one hit's checks leaves its checks `unknown`.
import type { TaggedWhy } from '../../../domain/tagged.ts';
import { TAGGED_WHYS } from '../../../domain/tagged.ts';
import type { TaggedSearchHit } from '../api.ts';
import { rollupChecks } from '../closer.ts';
import type { Request } from './http.ts';

/** GitHub's longest search query. */
export const SEARCH_QUERY_MAX = 256;
/** Hits read of one search. */
export const TAGGED_PAGE = 50;
/** Searches in one request. */
export const SEARCHES_MAX = 10;

const QUALIFIER: Record<TaggedWhy, (login: string) => string> = {
  review: (login) => `is:pr review-requested:${login}`,
  mention: (login) => `mentions:${login}`,
  assign: (login) => `assignee:${login}`,
};

/** One search: the reason it finds items for, and its query. */
export interface TaggedSearch { why: TaggedWhy; query: string }

/** The searches for `login` over `repos`: one per reason and group of repositories, each query at most SEARCH_QUERY_MAX long. */
export function taggedSearches(login: string, repos: readonly string[]): TaggedSearch[] {
  const unique = [...new Set(repos.map((r) => r.toLowerCase()))];
  return TAGGED_WHYS.flatMap((why) => {
    const base = `is:open archived:false ${QUALIFIER[why](login)}`;
    const out: TaggedSearch[] = [];
    let query = base;
    for (const repo of unique) {
      const next = `${query} repo:${repo}`;
      if (next.length > SEARCH_QUERY_MAX && query !== base) { out.push({ why, query }); query = `${base} repo:${repo}`; } else query = next;
    }
    if (query !== base) out.push({ why, query });
    return out;
  });
}

const FIELDS = 'number url title createdAt updatedAt author { login } labels(first: 30) { nodes { name } } repository { nameWithOwner }';
const NODE = `__typename ... on Issue { ${FIELDS} } ... on PullRequest { ${FIELDS} isDraft commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`;

export function taggedQuery(searches: readonly TaggedSearch[]): { query: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = {};
  const fields = searches.map((s, i) => {
    variables[`q${i}`] = s.query;
    return `s${i}: search(type: ISSUE, query: $q${i}, first: ${TAGGED_PAGE}) { nodes { ${NODE} } }`;
  });
  return { query: `query(${searches.map((_, i) => `$q${i}: String!`).join(', ')}) {\n${fields.join('\n')}\n}`, variables };
}

interface GqlNode {
  __typename?: string; number?: number; url?: string; title?: string; createdAt?: string; updatedAt?: string;
  author?: { login?: string } | null; labels?: { nodes?: ({ name?: string } | null)[] } | null;
  repository?: { nameWithOwner?: string } | null; isDraft?: boolean;
  commits?: { nodes?: ({ commit?: { statusCheckRollup?: { state?: string } | null } | null } | null)[] } | null;
}
interface GqlError { message?: string; path?: (string | number)[] }
export interface TaggedBody { data?: Record<string, { nodes?: (GqlNode | null)[] } | null> | null; errors?: GqlError[] }

/** The hits of one request's answer. */
export function taggedHits(searches: readonly TaggedSearch[], body: TaggedBody): TaggedSearchHit[] {
  const unknownChecks = new Set<string>();
  const fatal: string[] = [];
  for (const e of body.errors ?? []) {
    if (e.path?.at(-1) === 'statusCheckRollup') unknownChecks.add(`${String(e.path[0])}/${String(e.path[2])}`);
    else fatal.push(e.message ?? 'not answered');
  }
  if (!body.data || fatal.length) throw new Error(`GraphQL: ${fatal.join('; ') || 'no data'}`);
  return searches.flatMap((s, i) => (body.data![`s${i}`]?.nodes ?? []).flatMap((n, k): TaggedSearchHit[] => {
    if (!n || typeof n.number !== 'number' || !n.url || !n.repository?.nameWithOwner) return [];
    const pull = n.__typename === 'PullRequest';
    const hit: TaggedSearchHit = {
      key: n.url, repo: n.repository.nameWithOwner, number: n.number, kind: pull ? 'pull' : 'issue', title: n.title ?? '',
      author: n.author?.login ?? '', why: s.why, createdAt: n.createdAt ?? '', updatedAt: n.updatedAt ?? '',
      labels: (n.labels?.nodes ?? []).flatMap((l) => (l?.name ? [l.name] : [])),
    };
    if (!pull) return [hit];
    const rollup = n.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    const checks = unknownChecks.has(`s${i}/${k}`) ? 'unknown' : rollup ? rollupChecks(rollup) ?? 'unknown' : 'none';
    return [{ ...hit, checks, isDraft: n.isDraft ?? false }];
  }));
}

/** The tagged items of `login` in `repos`, with `token`, one hit per search and item. */
export async function taggedItems(req: Request, token: string, login: string, repos: string[]): Promise<TaggedSearchHit[]> {
  const searches = taggedSearches(login, repos);
  const out: TaggedSearchHit[] = [];
  for (let i = 0; i < searches.length; i += SEARCHES_MAX) {
    const chunk = searches.slice(i, i + SEARCHES_MAX);
    const body = (await req('POST /graphql', { ...taggedQuery(chunk), headers: { authorization: `token ${token}` } })).data as TaggedBody;
    out.push(...taggedHits(chunk, body ?? {}));
  }
  return out;
}
