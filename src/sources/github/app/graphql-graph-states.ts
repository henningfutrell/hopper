// The issue graph refresh's batched read (issue #1036, design.md "The job graph" part 5), shared by the App and the
// connected account adapters: the state of each issue and pull request the graph shows not done, each an alias in a
// request — `g0: repository(owner: $o0, name: $n0) { item: issueOrPullRequest(number: 7) { … } }` —, at most
// GRAPH_STATES_MAX to a request. An error on one alias fails only its item. A request that fails, or an error that names no
// alias, throws: the next refresh asks again.
import type { GraphItemRef, GraphItemState, GraphStates } from '../api.ts';
import { itemKey } from '../api.ts';
import type { Request } from './http.ts';
import { splitRepo } from './http.ts';

/** The most items in one request. */
export const GRAPH_STATES_MAX = 100;

const ITEM = '__typename ... on Issue { state stateReason } ... on PullRequest { state }';

interface GqlItem { __typename?: string; state?: string; stateReason?: string | null }
interface GqlError { message?: string; path?: (string | number)[] }
interface GqlBody { data?: Record<string, { item?: GqlItem | null } | null> | null; errors?: GqlError[] }

const STATES: Record<string, GraphItemState['state']> = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };

function stateOf(i: GqlItem | null | undefined): GraphItemState | undefined {
  const state = STATES[i?.state ?? ''];
  if (!state) return undefined;
  if (i?.__typename === 'PullRequest') return { kind: 'pull_request', state };
  if (i?.__typename !== 'Issue') return undefined;
  return { kind: 'issue', state, ...(state === 'closed' && i.stateReason ? { stateReason: i.stateReason.toLowerCase() } : {}) };
}

/** The states of `refs`, with `token`. */
export async function graphStates(req: Request, token: string, refs: GraphItemRef[]): Promise<GraphStates> {
  const out: GraphStates = { items: new Map(), errors: new Map() };
  for (let at = 0; at < refs.length; at += GRAPH_STATES_MAX) {
    const chunk = refs.slice(at, at + GRAPH_STATES_MAX);
    const params: string[] = [];
    const variables: Record<string, unknown> = {};
    const fields = chunk.map((r, i) => {
      const { owner, repo: name } = splitRepo(r.repo);
      Object.assign(variables, { [`o${i}`]: owner, [`n${i}`]: name });
      params.push(`$o${i}: String!`, `$n${i}: String!`);
      return `g${i}: repository(owner: $o${i}, name: $n${i}) { item: issueOrPullRequest(number: ${Math.trunc(r.number)}) { ${ITEM} } }`;
    });
    const query = `query(${params.join(', ')}) {\n${fields.join('\n')}\n}`;
    const body = ((await req('POST /graphql', { query, variables, headers: { authorization: `token ${token}` } })).data ?? {}) as GqlBody;
    const unnamed = (body.errors ?? []).filter((e) => !e.path?.length);
    if (!body.data || unnamed.length) throw new Error(`GraphQL: ${(unnamed.length ? unnamed : body.errors ?? []).map((e) => e.message ?? '').join('; ') || 'no data'}`);
    chunk.forEach((r, i) => {
      const alias = `g${i}`;
      const failed = (body.errors ?? []).find((e) => e.path![0] === alias);
      const state = failed ? undefined : stateOf(body.data![alias]?.item);
      if (state) out.items.set(itemKey(r.repo, r.number), state);
      else out.errors.set(itemKey(r.repo, r.number), failed?.message ?? 'not answered');
    });
  }
  return out;
}
