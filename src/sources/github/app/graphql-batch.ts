// Batched GraphQL reads (issue #822, design.md "Batched GraphQL reads"), shared by the App and the connected account
// adapters: the GraphQL reads of one issue or pull request — `repository(owner: $owner, name: $name) { … $number … }` —
// asked with the same token in the same turn of the event loop go to GitHub as one request, each read an alias (`q0`,
// `q1`, …) in it, at most GRAPHQL_BATCH_MAX to a request. The follows of a sync run side by side, so their reads meet
// here; GraphQL charges at least one point a request, and a request with many small reads costs about what one does.
// Each read gets the answer its own query would have had: its alias's data as `repository`, and the errors of its alias
// (and those of no alias). A request that fails fails each read in it. A read asked alone goes as its own query.
import { setImmediate } from 'node:timers';
import type { Request } from './http.ts';
import { splitRepo } from './http.ts';

/** The most reads in one request: each read stays well under GitHub's node limit, and so does their sum. */
export const GRAPHQL_BATCH_MAX = 20;

/** Ask `query` (one read of issue or pull request `number` of `repo`) with `token`; answers the GraphQL body. */
export type AskGraphQL = (token: string, query: string, repo: string, number: number) => Promise<unknown>;

interface Ask { query: string; owner: string; name: string; number: number; resolve(body: unknown): void; reject(err: unknown): void }
interface GqlError { path?: (string | number)[] }
interface GqlBody { data?: Record<string, unknown> | null; errors?: GqlError[] }

/** The selection inside `repository(…) { }` of a one-issue query. */
const SELECTION = /repository\(owner: \$owner, name: \$name\) \{([\s\S]*)\}\s*\}\s*$/;

function batchedQuery(asks: Ask[]): { query: string; variables: Record<string, unknown> } {
  const variables: Record<string, unknown> = {};
  const params: string[] = [];
  const fields = asks.map((a, i) => {
    const selection = SELECTION.exec(a.query)?.[1];
    if (selection === undefined) throw new Error(`not a query of one issue: ${a.query.slice(0, 60)}`);
    Object.assign(variables, { [`o${i}`]: a.owner, [`n${i}`]: a.name, [`k${i}`]: a.number });
    params.push(`$o${i}: String!, $n${i}: String!, $k${i}: Int!`);
    return `q${i}: repository(owner: $o${i}, name: $n${i}) {${selection.replaceAll('$number', `$k${i}`)}}`;
  });
  return { query: `query(${params.join(', ')}) {\n${fields.join('\n')}\n}`, variables };
}

/** Alias `q<i>`'s part of a batched answer, as its own query would have answered it. */
function partOf(body: GqlBody, i: number): GqlBody {
  const alias = `q${i}`;
  const errors = (body.errors ?? []).flatMap((e) => {
    if (!e.path?.length) return [e];
    return e.path[0] === alias ? [{ ...e, path: ['repository', ...e.path.slice(1)] }] : [];
  });
  return { ...(body.data ? { data: { repository: body.data[alias] ?? null } } : {}), ...(errors.length ? { errors } : {}) };
}

export function batchGraphQL(req: Request, max = GRAPHQL_BATCH_MAX): AskGraphQL {
  const waiting = new Map<string, Ask[]>();

  const send = async (token: string, asks: Ask[]) => {
    const headers = { authorization: `token ${token}` };
    try {
      if (asks.length === 1) {
        const [a] = asks as [Ask];
        a.resolve((await req('POST /graphql', { query: a.query, variables: { owner: a.owner, name: a.name, number: a.number }, headers })).data);
        return;
      }
      const body = (await req('POST /graphql', { ...batchedQuery(asks), headers })).data as GqlBody;
      asks.forEach((a, i) => a.resolve(partOf(body ?? {}, i)));
    } catch (err) {
      for (const a of asks) a.reject(err);
    }
  };

  const flush = () => {
    const all = [...waiting];
    waiting.clear();
    for (const [token, asks] of all) for (let i = 0; i < asks.length; i += max) void send(token, asks.slice(i, i + max));
  };

  return (token, query, repo, number) => {
    const { owner, repo: name } = splitRepo(repo);
    return new Promise((resolve, reject) => {
      if (waiting.size === 0) setImmediate(flush);
      const asks = waiting.get(token) ?? [];
      asks.push({ query, owner, name, number, resolve, reject });
      waiting.set(token, asks);
    });
  };
}
