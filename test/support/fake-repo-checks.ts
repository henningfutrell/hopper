// The fake GitHub's answers about a repository's checks for pull requests (issue #677), for test/support/fake-forges.ts:
// its default branch's protection and rulesets, its workflow files through the contents API, and the check rollups of its
// newest pull requests through GraphQL. A repository not named has none.
/**
 * What a repository has of checks for pull requests (issue #677): required status checks in its default branch's
 * protection and in its rulesets, its workflow files by name, and the check rollup of each of its newest pull requests
 * (`null`: none ran). `down`: GitHub answers 503 to all of it.
 */
export interface FakeRepoChecks { required?: string[]; ruleset?: string[]; workflows?: Record<string, string>; pullRequests?: (string | null)[]; down?: boolean }

/** The fake GitHub's option for it (a field of `FakeForge`). */
export interface RepoChecksForge {
  /** GitHub: each repository's checks for pull requests, by owner/name (issue #677); a repository not named here has none. */
  repoChecks?: Record<string, FakeRepoChecks>;
}

type Answer = { status: number; body?: unknown };

const notFound: Answer = { status: 404, body: { message: 'Not Found' } };
const down: Answer = { status: 503, body: { message: 'Service Unavailable' } };

/** GraphQL: the status check rollup of each of a repository's newest pull requests. */
function rollupsAnswer(all: Record<string, FakeRepoChecks> | undefined, variables: unknown): Answer {
  const v = (variables ?? {}) as Record<string, unknown>;
  const c = all?.[`${String(v.owner)}/${String(v.name)}`];
  if (c?.down) return down;
  const nodes = (c?.pullRequests ?? []).map((state) => ({ commits: { nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }] } }));
  return { status: 200, body: { data: { repository: { pullRequests: { nodes } } } } };
}

/** REST under `/repos/{owner}/{repo}/` (`rest`): branch protection, rulesets, workflow files; undefined: another route. */
function repoChecksAnswer(c: FakeRepoChecks | undefined, method: string, rest: string): Answer | undefined {
  if (method !== 'GET' || !/^(branches\/[^/]+|rules\/branches\/[^/]+|contents\/\.github\/workflows(\/.*)?)$/.test(rest)) return undefined;
  if (c?.down) return down;
  if (rest.startsWith('branches/')) {
    const contexts = c?.required ?? [];
    return { status: 200, body: { name: rest.slice('branches/'.length), protected: contexts.length > 0, protection: { enabled: contexts.length > 0, required_status_checks: { enforcement_level: contexts.length > 0 ? 'everyone' : 'off', contexts } } } };
  }
  if (rest.startsWith('rules/')) {
    const ruleset = c?.ruleset ?? [];
    return { status: 200, body: ruleset.length === 0 ? [] : [{ type: 'required_status_checks', parameters: { required_status_checks: ruleset.map((context) => ({ context })) } }] };
  }
  const files = c?.workflows ?? {};
  const name = decodeURIComponent(rest.slice('contents/.github/workflows'.length).replace(/^\//, ''));
  if (!name) return Object.keys(files).length === 0 ? notFound : { status: 200, body: Object.keys(files).map((f) => ({ name: f, path: `.github/workflows/${f}`, type: 'file' })) };
  const text = files[name];
  return text === undefined ? notFound : { status: 200, body: { name, encoding: 'base64', content: Buffer.from(text).toString('base64') } };
}

/** A request under `/api/v3` (`path`) about a repository's checks: its answer; undefined: another route. */
export function repoChecksRoute(all: Record<string, FakeRepoChecks> | undefined, method: string, path: string, body: Record<string, unknown>): Answer | undefined {
  if (method === 'POST' && path === '/graphql') return String(body.query).includes('statusCheckRollup') ? rollupsAnswer(all, body.variables) : undefined;
  const m = /^\/repos\/([^/]+\/[^/]+)\/(.*)$/.exec(path);
  return m ? repoChecksAnswer(all?.[m[1]!], method, m[2]!) : undefined;
}
