// GitHub traffic per sync pass (issue #858, design.md "GitHub traffic per sync pass"): what each sync pass asked of
// GitHub, counted before anything changes to ask less — its REST calls per route, its GraphQL calls per read of the
// source's port, and the git fetches per repository and per job that went through the hopper. A call made inside a pass
// counts for that pass; one made outside any (a job's git fetch, a job's own GitHub request, a GitHub watch) counts as
// "between passes", told by the next pass that ends. Each pass logs one line. Counts only: nothing is kept. Each pass has
// an id, so a fetch made in one is not made again in it (issue #858 part 2): the hopper's own mirror, a machine's at a job start.
import { AsyncLocalStorage } from 'node:async_hooks';

/** What was asked of GitHub: each key's count. */
export interface Traffic {
  rest: Map<string, number>;
  graphql: Map<string, number>;
  /** Git fetches per repository (`owner/name`). */
  fetches: Map<string, number>;
  /** Git fetches by who made them: a job (its id's first 8), or the hopper's own mirror (`hopper`). */
  jobFetches: Map<string, number>;
}

export interface GitHubTraffic {
  /** One call to GitHub's API: `url` the route (a template where Octokit had one); a GraphQL call is named by its read, else its query. */
  call(method: string, url: string, query?: unknown): void;
  /** One git fetch of `repo` from GitHub: by job `jobId` through the hopper, or, with none, by the hopper's own mirror. */
  gitFetch(repo: string, jobId?: string): void;
  /** `run` as the port's read or write `name`: the GraphQL calls it makes are counted under it. */
  read<T>(name: string, run: () => T): T;
  /** One sync pass of source `name`: its line is logged when it ends, with what went between passes since the last line. */
  pass<T>(name: string, run: () => Promise<T>): Promise<T>;
  /** The id of the pass this runs in; undefined outside any. */
  passId(): number | undefined;
  /** The id of the newest pass begun, of any source; 0 before the first. */
  lastPass(): number;
}

interface Scope { traffic: Traffic; id: number; read?: string }

const empty = (): Traffic => ({ rest: new Map(), graphql: new Map(), fetches: new Map(), jobFetches: new Map() });
const add = (m: Map<string, number>, key: string): void => { m.set(key, (m.get(key) ?? 0) + 1); };
const total = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
const each = (m: Map<string, number>): string => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(', ');
const counted = (label: string, m: Map<string, number>): string => `${label} ${total(m)}${m.size ? ` (${each(m)})` : ''}`;

/** A route as the line names it: no origin, no query, so the pages of one list are one route. */
export const routeOf = (url: string): string => url.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '') || '/';

/** A GraphQL call with no read to name it: its operation name, else the fields it asks first (`repository.issue`). */
export function graphqlNameOf(query: unknown): string {
  if (typeof query !== 'string') return 'graphql';
  const named = /^\s*(?:query|mutation)\s+([A-Za-z_]\w*)/.exec(query)?.[1];
  if (named) return named;
  const body = query.replace(/^\s*(?:query|mutation)\b[^{]*/, '').replace(/\([^)]*\)/g, '');
  const path = /^\s*\{\s*([A-Za-z_]\w*)\s*(?:\{\s*([A-Za-z_]\w*))?/.exec(body);
  return path ? [path[1], path[2]].filter(Boolean).join('.') : 'graphql';
}

/** The line a pass logs: its counts, then what went between passes, when anything did. */
export function trafficLine(name: string, pass: Traffic, between: Traffic): string {
  const part = (t: Traffic): string => [
    counted('REST', t.rest), counted('GraphQL', t.graphql),
    `git fetches ${total(t.fetches)}${t.fetches.size ? ` (${each(t.fetches)}; by ${each(t.jobFetches)})` : ''}`,
  ].join(', ');
  const quiet = (t: Traffic): boolean => !t.rest.size && !t.graphql.size && !t.fetches.size;
  return `hopper: GitHub traffic of sync pass ${name}: ${part(pass)}${quiet(between) ? '' : `; between passes: ${part(between)}`}`;
}

export function createGitHubTraffic(o: { log(line: string): void }): GitHubTraffic {
  const scope = new AsyncLocalStorage<Scope>();
  let between = empty();
  let passes = 0;
  const current = (): Traffic => scope.getStore()?.traffic ?? between;
  return {
    call(method, url, query) {
      const route = routeOf(url);
      if (route.endsWith('/graphql')) add(current().graphql, scope.getStore()?.read ?? graphqlNameOf(query));
      else add(current().rest, `${method.toUpperCase()} ${route}`);
    },
    gitFetch(repo, jobId) {
      const t = current();
      add(t.fetches, repo);
      add(t.jobFetches, jobId ? jobId.slice(0, 8) : 'hopper');
    },
    read(name, run) {
      const s = scope.getStore();
      return s ? scope.run({ ...s, read: name }, run) : run();
    },
    passId: () => scope.getStore()?.id,
    lastPass: () => passes,
    async pass(name, run) {
      const traffic = empty();
      const id = ++passes;
      try {
        return await scope.run({ traffic, id }, run);
      } finally {
        const before = between;
        between = empty();
        o.log(trafficLine(name, traffic, before));
      }
    },
  };
}

/** The one traffic count of this process: the shared limiter and the git proxy count into it, each sync pass logs it. */
export const githubTraffic = createGitHubTraffic({ log: (line) => console.warn(line) });
