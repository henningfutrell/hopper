// The fake GitHub's answers about a repository's checks for pull requests (issue #677), for test/support/fake-forges.ts:
// its default branch's protection and rulesets, its workflow files through the contents API, and the check rollups of its
// newest pull requests through GraphQL. A repository not named has none. Its setup (issue #652): the branches it has,
// each one's protection — shown in full only to a repository admin — and rulesets, and its secret scanning and push
// protection, shown only to an admin. Each REST answer has an ETag (issue #1250). The logs of its GitHub Actions jobs (issue #993) are fake-job-logs.ts, exported from
// here beside the checks.
import { createHash } from 'node:crypto';

export { jobLogBlobRoute, jobLogsRoute, type JobLogsForge } from './fake-job-logs.ts';

/** One branch's protection and rules (issue #652). `protection` absent: the branch has no branch protection. */
export interface FakeBranch {
  protection?: { pullRequest?: boolean; forcePushes?: boolean; checks?: string[] };
  /** The rule types of the rulesets on it: `pull_request`, `non_fast_forward`, `required_status_checks` (check `ruleset`). */
  rules?: string[];
}

/** A repository's setup (issue #652). */
export interface FakeRepoSetup {
  /** Its branches by name; the default branch is `dev`. Absent: only `dev`, protected by `required` and `ruleset`. */
  branches?: Record<string, FakeBranch>;
  /** The connection is a repository admin: GitHub shows the branch protection and the security settings. */
  admin?: boolean;
  secretScanning?: boolean;
  pushProtection?: boolean;
}

/**
 * What a repository has of checks for pull requests (issue #677): required status checks in its default branch's
 * protection and in its rulesets, its workflow files by name, and the check rollup of each of its newest pull requests
 * (`null`: none ran). `down`: GitHub answers 503 to all of it. `setup`: its branches and security settings (issue #652).
 */
export interface FakeRepoChecks { required?: string[]; ruleset?: string[]; workflows?: Record<string, string>; pullRequests?: (string | null)[]; down?: boolean; setup?: FakeRepoSetup }

/** The fake GitHub's option for it (a field of `FakeForge`). */
export interface RepoChecksForge {
  /** GitHub: each repository's checks for pull requests, by owner/name (issue #677); a repository not named here has none. */
  repoChecks?: Record<string, FakeRepoChecks>;
}

type Answer = { status: number; body?: unknown; etag?: string };

/** An answer's ETag: the same body, the same tag. */
const etagOf = (body: unknown): string => `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;

/** A 200 with its ETag, as GitHub answers a list (issue #1250): a request that names the tag is answered 304. */
export const tagged = (body: unknown): Answer => ({ status: 200, body, etag: etagOf(body) });

const notFound: Answer = { status: 404, body: { message: 'Not Found' } };
const down: Answer = { status: 503, body: { message: 'Service Unavailable' } };
const forbidden: Answer = { status: 403, body: { message: 'Resource not accessible by integration' } };

/** GraphQL: the status check rollup of each of a repository's newest pull requests. */
function rollupsAnswer(all: Record<string, FakeRepoChecks> | undefined, variables: unknown): Answer {
  const v = (variables ?? {}) as Record<string, unknown>;
  const c = all?.[`${String(v.owner)}/${String(v.name)}`];
  if (c?.down) return down;
  const nodes = (c?.pullRequests ?? []).map((state) => ({ commits: { nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }] } }));
  return { status: 200, body: { data: { repository: { pullRequests: { nodes } } } } };
}

/** The repository's branches: its setup's, else `dev` alone with the classic `required` checks and the `ruleset` ones. */
function branchesOf(c: FakeRepoChecks | undefined): Record<string, FakeBranch> {
  if (c?.setup?.branches) return c.setup.branches;
  const required = c?.required ?? [];
  return { dev: { ...(required.length > 0 ? { protection: { checks: required } } : {}), rules: (c?.ruleset ?? []).length > 0 ? ['required_status_checks'] : [] } };
}

/** `branches/{b}`, `branches/{b}/protection`, `rules/branches/{b}`. */
function branchAnswer(c: FakeRepoChecks | undefined, rest: string): Answer {
  const [kind, name, more] = rest.startsWith('rules/') ? ['rules', ...rest.slice('rules/branches/'.length).split('/')] : ['branch', ...rest.slice('branches/'.length).split('/')];
  const branch = branchesOf(c)[decodeURIComponent(name ?? '')];
  if (!branch) return { status: 404, body: { message: 'Branch not found' } };
  const p = branch.protection;
  if (kind === 'rules') {
    return {
      status: 200, body: (branch.rules ?? []).map((type) => (type === 'required_status_checks'
        ? { type, parameters: { required_status_checks: (c?.ruleset ?? ['ruleset-check']).map((context) => ({ context })) } }
        : { type })),
    };
  }
  if (more === 'protection') {
    if (!c?.setup?.admin) return forbidden;
    if (!p) return { status: 404, body: { message: 'Branch not protected' } };
    return {
      status: 200, body: {
        required_status_checks: { contexts: p.checks ?? [] },
        ...(p.pullRequest ? { required_pull_request_reviews: { required_approving_review_count: 0 } } : {}),
        allow_force_pushes: { enabled: p.forcePushes === true },
      },
    };
  }
  const contexts = p?.checks ?? [];
  return { status: 200, body: { name, protected: p !== undefined, protection: { enabled: p !== undefined, required_status_checks: { enforcement_level: contexts.length > 0 ? 'everyone' : 'off', contexts } } } };
}

const status = (on: boolean | undefined) => ({ status: on ? 'enabled' : 'disabled' });

/** REST under `/repos/{owner}/{repo}/` (`rest`): branch protection, rulesets, workflow files; undefined: another route. */
function repoChecksAnswer(repo: string, c: FakeRepoChecks | undefined, method: string, rest: string): Answer | undefined {
  if (method !== 'GET') return undefined;
  // The repository itself: the security settings only for an admin; with no setup, the forge's own answer.
  if (rest === '' && c?.setup) {
    const s = c.setup;
    return { status: 200, body: { full_name: repo, default_branch: 'dev', ...(s.admin ? { security_and_analysis: { secret_scanning: status(s.secretScanning), secret_scanning_push_protection: status(s.pushProtection) } } : {}) } };
  }
  if (!/^(branches\/[^/]+(\/protection)?|rules\/branches\/[^/]+|contents\/\.github\/workflows(\/.*)?)$/.test(rest)) return undefined;
  if (c?.down) return down;
  if (!rest.startsWith('contents/')) return branchAnswer(c, rest);
  const files = c?.workflows ?? {};
  const name = decodeURIComponent(rest.slice('contents/.github/workflows'.length).replace(/^\//, ''));
  if (!name) return Object.keys(files).length === 0 ? notFound : { status: 200, body: Object.keys(files).map((f) => ({ name: f, path: `.github/workflows/${f}`, type: 'file' })) };
  const text = files[name];
  return text === undefined ? notFound : { status: 200, body: { name, encoding: 'base64', content: Buffer.from(text).toString('base64') } };
}

/** A request under `/api/v3` (`path`) about a repository's checks: its answer; undefined: another route. */
export function repoChecksRoute(all: Record<string, FakeRepoChecks> | undefined, method: string, path: string, body: Record<string, unknown>): Answer | undefined {
  if (method === 'POST' && path === '/graphql') return String(body.query).includes('statusCheckRollup') ? rollupsAnswer(all, body.variables) : undefined;
  const m = /^\/repos\/([^/]+\/[^/]+)\/?(.*)$/.exec(path);
  const a = m ? repoChecksAnswer(m[1]!, all?.[m[1]!], method, m[2]!) : undefined;
  // A REST answer has an ETag, as on GitHub (issue #1250): the same body, the same tag, and a 304 for a request that names it.
  return a?.status === 200 ? { ...a, etag: etagOf(a.body) } : a;
}
