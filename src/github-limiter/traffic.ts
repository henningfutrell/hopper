// GitHub traffic per sync pass (issue #858, design.md "GitHub traffic per sync pass"): what each sync pass asked of
// GitHub, counted before anything changes to ask less — its REST calls per route, its GraphQL calls per read of the
// source's port, and the git fetches per repository and per job that went through the hopper. A call made inside a pass
// counts for that pass; one made outside any (a job's git fetch, a job's own GitHub request, a GitHub watch) counts as
// "between passes", told by the next pass that ends. Each pass logs one line. Counts only: nothing is kept. Each pass has
// an id, so a fetch made in one is not made again in it (issue #858 part 2): the hopper's own mirror, a machine's at a job start.
// It also counts the calls GitHub charged in the last hour by kind (issue #985 part 4): in memory, 60 one-minute buckets.
// A pass's caller may be told its calls when it ends (issue #1264): the sync loop keeps them per source in the call log.
import { AsyncLocalStorage } from 'node:async_hooks';
import { GITHUB_CALL_KINDS, type GitHubCallKind, type HourlyCalls } from '../domain/github-rate-limit.ts';

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
  /** `run` as the port's read or write `name`: the GraphQL calls it makes are counted under it, and its kind is told from it. */
  read<T>(name: string, run: () => T): T;
  /**
   * One call GitHub charged (issue #985): it answered with data or refused, not a 304. `kind`: the caller's, else told from
   * the read that made it (`callKindOf`). `points`: what a GraphQL call spent of its rate limit.
   */
  charged(method: string, url: string, query: unknown, o: { kind?: GitHubCallKind; points: number }): void;
  /** The calls charged in the last hour, by kind. */
  hourly(): HourlyCalls;
  /**
   * One sync pass of source `name`: its line is logged when it ends, with what went between passes since the last line.
   * `counted`: told its REST and GraphQL calls when it ends (issue #1264, the call log). `idle`: why the pass takes nothing
   * new (issue #1351: a paused or unconfigured source), which its line says, so its zero never reads as a healthy pass.
   */
  pass<T>(name: string, run: () => Promise<T>, counted?: (calls: number) => void, idle?: string): Promise<T>;
  /** The id of the pass this runs in; undefined outside any. */
  passId(): number | undefined;
  /** The id of the newest pass begun, of any source; 0 before the first. */
  lastPass(): number;
}

interface Scope { traffic?: Traffic; id?: number; read?: string }

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

/** The port's reads that look for new jobs (issue #983), and those of the in-motion cycle (issue #985). */
const INTAKE_READS = new Set(['listRepos', 'issuesChangedSince', 'listAssignedIssues', 'listInstalledRepos', 'projectItems']);
const CYCLE_READS: Record<string, GitHubCallKind> = { openPullRequestsIn: 'reconcile', pullRequestStates: 'pr_cycle' };

/**
 * The kind of a call (issue #985): from the read that made it — intake, reconcile, the in-motion cycle —, else a GET or a
 * GraphQL query is a job's read, and anything else (a REST write, a GraphQL mutation) a write.
 */
export function callKindOf(read: string | undefined, method: string, url: string, query?: unknown): GitHubCallKind {
  if (read !== undefined && INTAKE_READS.has(read)) return 'intake';
  const cycle = read === undefined ? undefined : CYCLE_READS[read];
  if (cycle) return cycle;
  if (routeOf(url).endsWith('/graphql')) return typeof query === 'string' && /^\s*mutation\b/.test(query) ? 'write' : 'per_job_read';
  return method.toUpperCase() === 'GET' ? 'per_job_read' : 'write';
}

const MINUTE = 60_000;
const HOUR_MINUTES = 60;

/** A rolling hour of counts per kind: one bucket a minute, the oldest dropped as the minutes pass. */
function rollingHour(now: () => number) {
  const minutes = new Map<number, Map<GitHubCallKind, { calls: number; points: number }>>();
  const prune = (current: number) => { for (const m of minutes.keys()) if (m <= current - HOUR_MINUTES) minutes.delete(m); };
  return {
    add(kind: GitHubCallKind, points: number) {
      const m = Math.floor(now() / MINUTE);
      prune(m);
      let bucket = minutes.get(m);
      if (!bucket) minutes.set(m, bucket = new Map());
      const c = bucket.get(kind) ?? { calls: 0, points: 0 };
      bucket.set(kind, { calls: c.calls + 1, points: c.points + points });
    },
    totals(): HourlyCalls {
      prune(Math.floor(now() / MINUTE));
      const out = Object.fromEntries(GITHUB_CALL_KINDS.map((k) => [k, { calls: 0, points: 0 }])) as HourlyCalls;
      for (const bucket of minutes.values()) for (const [k, c] of bucket) { out[k].calls += c.calls; out[k].points += c.points; }
      return out;
    },
  };
}

/** The line a pass logs: why it takes nothing new, if so; its counts; then what went between passes, when anything did. */
export function trafficLine(name: string, pass: Traffic, between: Traffic, idle?: string): string {
  const part = (t: Traffic): string => [
    counted('REST', t.rest), counted('GraphQL', t.graphql),
    `git fetches ${total(t.fetches)}${t.fetches.size ? ` (${each(t.fetches)}; by ${each(t.jobFetches)})` : ''}`,
  ].join(', ');
  const quiet = (t: Traffic): boolean => !t.rest.size && !t.graphql.size && !t.fetches.size;
  return `hopper: GitHub traffic of sync pass ${name}${idle === undefined ? '' : ` (nothing new taken: ${idle})`}: ${part(pass)}${quiet(between) ? '' : `; between passes: ${part(between)}`}`;
}

export function createGitHubTraffic(o: { log(line: string): void; now?: () => number }): GitHubTraffic {
  const scope = new AsyncLocalStorage<Scope>();
  let between = empty();
  let passes = 0;
  const hour = rollingHour(o.now ?? Date.now);
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
      return scope.run({ ...scope.getStore(), read: name }, run);
    },
    charged(method, url, query, c) {
      hour.add(c.kind ?? callKindOf(scope.getStore()?.read, method, url, query), c.points);
    },
    hourly: () => hour.totals(),
    passId: () => scope.getStore()?.id,
    lastPass: () => passes,
    async pass(name, run, counted, idle) {
      const traffic = empty();
      const id = ++passes;
      try {
        return await scope.run({ traffic, id }, run);
      } finally {
        const before = between;
        between = empty();
        o.log(trafficLine(name, traffic, before, idle));
        counted?.(total(traffic.rest) + total(traffic.graphql));
      }
    },
  };
}

/** The one traffic count of this process: the shared limiter and the git proxy count into it, each sync pass logs it. */
export const githubTraffic = createGitHubTraffic({ log: (line) => console.warn(line) });
