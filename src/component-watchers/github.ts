// What the component watchers ask GitHub (issue #1077, design.md "Component watchers"), with the user's own GitHub
// connection, through `makeRequest`, so the shared rate limiter paces every call: the state of many issues and pull
// requests in one GraphQL call (`resource(url:)`, `STATES_BATCH` at a time), the head of many repositories' default
// branches with their checks' rollup in one GraphQL call (`BRANCHES_BATCH` at a time), and the drift issues on the
// hopper's own repository — found by the drift key in their body, filed, and updated in place.
import type { GitHubItemState } from '../domain/drift.ts';
import type { BranchHead } from '../domain/drift-branches.ts';
import { DRIFT_MARKER } from '../domain/drift.ts';
import { tokenCaller, type TokenSource } from '../github-proxy/index.ts';
import { makeRequest, splitRepo, statusOf } from '../sources/github/http/http.ts';
import { REPORT_LABEL, REPORT_REPO } from '../bug-reports/context.ts';

/** How many issues and pull requests one GraphQL call reads. */
export const STATES_BATCH = 50;

export interface GitHubStates {
  /** The state of each URL GitHub answers for; one it does not (gone, no access) is absent. */
  states(urls: readonly string[]): Promise<Map<string, GitHubItemState>>;
}

/** How many repositories one GraphQL call reads the default branch of. */
export const BRANCHES_BATCH = 50;

export interface GitHubBranches {
  /** The head of each repository's default branch, with its checks; a repository GitHub does not answer for is absent. */
  heads(repos: readonly string[]): Promise<BranchHead[]>;
}

/** The drift issues, on the hopper's own repository. */
export interface DriftGitHub {
  /** The open drift issue whose body names `key`, when there is one. */
  find(key: string): Promise<{ number: number; url: string } | undefined>;
  file(issue: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }>;
  update(number: number, issue: { title: string; body: string }): Promise<void>;
}

/** The query for `urls`: each a variable, never in the query text. */
export function statesQuery(urls: readonly string[]): { query: string; variables: Record<string, string> } {
  const fields = '__typename ... on Issue { state stateReason closedAt } ... on PullRequest { state merged mergedAt closedAt }';
  return {
    query: `query(${urls.map((_, n) => `$u${n}: URI!`).join(', ')}) { ${urls.map((_, n) => `i${n}: resource(url: $u${n}) { ${fields} }`).join(' ')} }`,
    variables: Object.fromEntries(urls.map((u, n) => [`u${n}`, u])),
  };
}

/** The query for `repos` (`owner/name`): each owner and name a variable, never in the query text. */
export function branchesQuery(repos: readonly string[]): { query: string; variables: Record<string, string> } {
  const fields = 'defaultBranchRef { target { ... on Commit { committedDate statusCheckRollup { state } } } }';
  return {
    query: `query(${repos.map((_, n) => `$o${n}: String!, $n${n}: String!`).join(', ')}) { ${repos.map((_, n) => `r${n}: repository(owner: $o${n}, name: $n${n}) { ${fields} }`).join(' ')} }`,
    variables: Object.fromEntries(repos.flatMap((r, n) => { const [owner = '', name = ''] = r.split('/'); return [[`o${n}`, owner], [`n${n}`, name]]; })),
  };
}

const ROLLUPS = new Set(['success', 'failure', 'error', 'pending', 'expected']);

/** GitHub's answer to `branchesQuery(repos)` as the heads of their default branches. */
export function branchesFrom(repos: readonly string[], data: Record<string, Raw>): BranchHead[] {
  return repos.flatMap((repo, n) => {
    const target = ((data[`r${n}`]?.defaultBranchRef as Raw)?.target) as Raw;
    if (!target) return [];
    const rollup = str((target.statusCheckRollup as Raw)?.state)?.toLowerCase();
    const committedAt = str(target.committedDate);
    return [{ repo, ...(committedAt ? { committedAt } : {}), ...(rollup && ROLLUPS.has(rollup) ? { checks: rollup as BranchHead['checks'] } : {}) }];
  });
}

type Raw = Record<string, unknown> | null | undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** GitHub's answer to `statesQuery(urls)` as states by URL. */
export function statesFrom(urls: readonly string[], data: Record<string, Raw>): Map<string, GitHubItemState> {
  const out = new Map<string, GitHubItemState>();
  urls.forEach((url, n) => {
    const r = data[`i${n}`];
    if (!r || (r.__typename !== 'Issue' && r.__typename !== 'PullRequest')) return;
    const raw = (str(r.state) ?? '').toLowerCase();
    const state = r.merged === true || raw === 'merged' ? 'merged' : raw === 'closed' ? 'closed' : 'open';
    const reason = state === 'closed' ? str(r.stateReason)?.toLowerCase() : undefined;
    const changedAt = state === 'merged' ? str(r.mergedAt) ?? str(r.closedAt) : state === 'closed' ? str(r.closedAt) : undefined;
    out.set(url, { url, state, ...(reason ? { stateReason: reason } : {}), ...(changedAt ? { changedAt } : {}) });
  });
  return out;
}

/** GitHub's refusal or failure, with its status when it gave one. */
export class WatcherGitHubError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'WatcherGitHubError';
    if (status !== undefined) this.status = status;
  }
}

export function createWatcherGitHub(o: { apiUrl: string } & TokenSource): GitHubStates & GitHubBranches & DriftGitHub {
  // A watcher's reads compare what the hopper holds with GitHub: reconcile calls (issue #985).
  const req = makeRequest(o.apiUrl, undefined, { kind: 'reconcile' });
  const withToken = tokenCaller(o);
  const failed = (what: string) => (err: unknown): Error => {
    const e = err as { message?: unknown; response?: { data?: { message?: unknown } } };
    const message = typeof e.response?.data?.message === 'string' ? e.response.data.message : String(e.message ?? err);
    return new WatcherGitHubError(`GitHub answered ${statusOf(err) ?? 'no status'} to ${what}: ${message}`, statusOf(err));
  };
  const headers = (token: string) => ({ authorization: `token ${token}` });
  const repo = splitRepo(REPORT_REPO);
  return {
    async states(urls) {
      const out = new Map<string, GitHubItemState>();
      for (let at = 0; at < urls.length; at += STATES_BATCH) {
        const batch = urls.slice(at, at + STATES_BATCH);
        const found = await withToken(async (token) => {
          const d = (await req('POST /graphql', { ...statesQuery(batch), headers: headers(token) })).data as { data?: Record<string, Raw>; errors?: { message?: string }[] };
          // A URL GitHub cannot resolve is an error beside the others' data: only no data at all fails the read.
          if (!d.data) throw new Error(d.errors?.map((e) => e.message).join('; ') || 'no data');
          return statesFrom(batch, d.data);
        }, failed('the state read'));
        for (const [k, v] of found) out.set(k, v);
      }
      return out;
    },
    async heads(repos) {
      const out: BranchHead[] = [];
      for (let at = 0; at < repos.length; at += BRANCHES_BATCH) {
        const batch = repos.slice(at, at + BRANCHES_BATCH);
        out.push(...await withToken(async (token) => {
          const d = (await req('POST /graphql', { ...branchesQuery(batch), headers: headers(token) })).data as { data?: Record<string, Raw>; errors?: { message?: string }[] };
          // A repository GitHub cannot resolve is an error beside the others' data: only no data at all fails the read.
          if (!d.data) throw new Error(d.errors?.map((e) => e.message).join('; ') || 'no data');
          return branchesFrom(batch, d.data);
        }, failed('the default branch read')));
      }
      return out;
    },
    find: (key) => withToken(async (token) => {
      const marker = `${DRIFT_MARKER}${key}`;
      const q = `repo:${REPORT_REPO} is:issue is:open label:${REPORT_LABEL} in:body "${marker.replaceAll('"', '')}"`;
      const d = (await req('GET /search/issues', { q, per_page: 20, headers: headers(token) })).data as { items: { number: number; html_url: string; body?: string | null; pull_request?: unknown }[] };
      // Search matches words, not the line: only an issue whose body ends its line with the key is the drift's.
      const hit = d.items.find((i) => i.pull_request === undefined && (i.body ?? '').split('\n').some((l) => l.trim() === marker));
      return hit ? { number: hit.number, url: hit.html_url } : undefined;
    }, failed(`the search of ${REPORT_REPO}`)),
    file: (issue) => withToken(async (token) => {
      const d = (await req('POST /repos/{owner}/{repo}/issues', { ...repo, ...issue, headers: headers(token) })).data as { number: number; html_url: string };
      return { number: d.number, url: d.html_url };
    }, failed(`a new issue on ${REPORT_REPO}`)),
    update: (number, issue) => withToken(async (token) => {
      await req('PATCH /repos/{owner}/{repo}/issues/{issue_number}', { ...repo, issue_number: number, ...issue, headers: headers(token) });
    }, failed(`an update of ${REPORT_REPO}#${number}`)),
  };
}
