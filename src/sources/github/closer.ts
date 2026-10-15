// The pull requests of an issue, over GraphQL, read by the connected account's adapter: what
// closed it (the last ClosedEvent's closer — only a merged pull request counts; a person, a commit
// or a project closing it is undefined), and the open pull requests whose merge will close it
// (`closedByPullRequestsReferences`: a closing keyword, on a pull request to the default branch), and the pull
// requests that mention it in any state (the issue's cross-references, issue #579: a part says "Part of #N"), and a pull
// request by its number (issue #618: one an issue names to update), and the open pull requests of a repository with their
// branches (issue #637: one named for an issue). Each says when its head commit was made, and its checks (issue #637). And
// an issue's cross-references (issue #430): the pull requests and commits that mention it, with their text, and the ones
// GitHub links as closing it.

import { GitHubApiError } from './api.ts';
import { explained, permissionsOfPath } from './http/refusal.ts';
import type { BranchPullRequest, ClosingPullRequest, NumberedPullRequest, OpenPullRequest, ReferencingPullRequest } from './api.ts';
import { MAX_CHECK_REPORTED, MAX_CHECK_REPORTED_CHARS, MAX_FAILED_CHECKS, type ChecksState, type FailedCheck } from '../../domain/pull-requests.ts';
import type { CrossReferenceKind, IssueCrossReferences, Mention } from '../../domain/cross-references.ts';

/**
 * A pull request's head commit and base (issue #858), its head branch (issue #900: a stack), when the head was made (issue
 * #618), and its checks (issue #637).
 */
const HEAD_COMMIT = 'headRefOid headRefName baseRefName commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }';
/**
 * The head commit with each check's end (issue #927), for the one pull request a follow reads: a failed check counts while
 * others still run. Not in the lists, where 100 checks of 100 pull requests would cost too much of the rate limit.
 */
const HEAD_COMMIT_CHECKS = 'headRefOid headRefName baseRefName commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state contexts(first: 100) { nodes { __typename ... on CheckRun { name conclusion detailsUrl annotations(first: 20) { nodes { path title message annotationLevel location { start { line } } } } } ... on StatusContext { context state targetUrl } } } } } } }';

export const CLOSING_PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent {
      closer { __typename ... on PullRequest { url createdAt mergedAt } }
    } } }
  } }
}`;

export const OPEN_PULL_REQUESTS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    closedByPullRequestsReferences(first: 50, includeClosedPrs: false) { nodes { url createdAt isDraft state mergeable ${HEAD_COMMIT} } }
  } }
}`;

export const REFERENCING_PULL_REQUESTS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 100) { nodes { ... on CrossReferencedEvent {
      source { __typename ... on PullRequest { url createdAt isDraft state mergeable mergedAt ${HEAD_COMMIT} body repository { nameWithOwner } } }
    } } }
  } }
}`;

export const PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issueOrPullRequest(number: $number) {
    __typename ... on PullRequest { url createdAt isDraft state mergeable mergedAt ${HEAD_COMMIT_CHECKS} }
  } }
}`;

export const OPEN_REPO_PULL_REQUESTS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [OPEN], first: 100, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { url createdAt isDraft state mergeable body ${HEAD_COMMIT} } }
  }
}`;

interface Annotation { path?: string | null; title?: string | null; message?: string | null; annotationLevel?: string | null; location?: { start?: { line?: number | null } | null } | null }
interface Context {
  name?: string; conclusion?: string | null; detailsUrl?: string | null; context?: string; state?: string; targetUrl?: string | null;
  annotations?: { nodes?: (Annotation | null)[] } | null;
}
interface Rollup { state?: string; contexts?: { nodes?: (Context | null)[] } }
interface Closer { __typename?: string; url?: string; createdAt?: string; mergedAt?: string | null }
interface Referenced {
  url?: string; createdAt?: string; isDraft?: boolean; state?: string; mergeable?: string;
  commits?: { nodes?: ({ commit?: { committedDate?: string; statusCheckRollup?: Rollup | null } } | null)[] };
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  body?: string;
}
interface Numbered extends Referenced { __typename?: string; mergedAt?: string | null }
interface Source extends Referenced { __typename?: string; body?: string; mergedAt?: string | null; repository?: { nameWithOwner?: string } }
const PR_STATES: Record<string, ReferencingPullRequest['state']> = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };
interface GqlResponse {
  data?: { repository?: { issueOrPullRequest?: Numbered | null; pullRequests?: { nodes?: (Referenced | null)[] }; issue?: {
    timelineItems?: { nodes?: ({ closer?: Closer | null; source?: Source | null } | null)[] };
    closedByPullRequestsReferences?: { nodes?: (Referenced | null)[] };
  } | null } | null };
  errors?: GqlError[];
}
interface GqlError { type?: string; message?: string; path?: (string | number)[] }

const PERMANENT_TYPES = new Set(['NOT_FOUND', 'FORBIDDEN']);

/** A head commit's checks the app may not read (issue #855): it has no Checks and Commit statuses read; the rest of the answer holds. */
const checksForbidden = (e: GqlError): boolean => e.type === 'FORBIDDEN' && e.path?.at(-1) === 'statusCheckRollup';

/**
 * Throws a GitHubApiError for a GraphQL error (NOT_FOUND/FORBIDDEN permanent, the rest transient), but for checks the app
 * may not read: `checksUnknown`.
 */
function response(body: unknown, what: string): GqlResponse & { checksUnknown: boolean } {
  const r = (body ?? {}) as GqlResponse;
  const errors = (r.errors ?? []).filter((e) => !checksForbidden(e));
  if (errors.length) {
    const message = `${what}: ${errors.map((e) => explained(e.message ?? e.type ?? 'error', permissionsOfPath(e.path))).join('; ')}`;
    throw new GitHubApiError(message, errors.some((e) => PERMANENT_TYPES.has(e.type ?? '')));
  }
  return { ...r, checksUnknown: errors.length < (r.errors?.length ?? 0) };
}

export function closingPullRequestFrom(body: unknown, what: string): ClosingPullRequest | undefined {
  const r = response(body, what);
  const c = r.data?.repository?.issue?.timelineItems?.nodes?.at(-1)?.closer;
  if (c?.__typename !== 'PullRequest' || !c.url || !c.createdAt || !c.mergedAt) return undefined;
  return { url: c.url, createdAt: c.createdAt, mergedAt: c.mergedAt };
}

/** GitHub's rollup state as the port's checks: none (no checks) is absent. */
const CHECKS: Record<string, ChecksState> = { SUCCESS: 'passing', PENDING: 'pending', EXPECTED: 'pending', FAILURE: 'failing', ERROR: 'failing' };

/** A check run's conclusion, or a commit status's state, that fails the checks (issue #927). */
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ERROR']);

/**
 * The rollup's state, but failing once one of its checks failed (issue #927): GitHub keeps the rollup pending while other
 * checks still run, and a failure must not wait for them.
 */
export const rollupChecks = (r: Rollup | null | undefined): ChecksState | undefined => {
  const state = CHECKS[r?.state ?? ''];
  if (state !== 'pending') return state;
  return r?.contexts?.nodes?.some((n) => FAILED.has(n?.conclusion ?? n?.state ?? '')) ? 'failing' : state;
};

/** The runner's own line for a step that exited non-zero: it says nothing a fix can use. */
const EXIT_LINE = /^Process completed with exit code \d+\.?$/;

/**
 * What a failed check run reported (issue #927): its failure annotations, `path:line: title: message`, at most
 * `MAX_CHECK_REPORTED`, each cut to `MAX_CHECK_REPORTED_CHARS`. Not the runner's exit line.
 */
const reportedOf = (c: Context): string[] =>
  (c.annotations?.nodes ?? []).flatMap((a): string[] => {
    const message = a?.message?.trim();
    if (!a || !message || a.annotationLevel !== 'FAILURE' || EXIT_LINE.test(message)) return [];
    const line = a.location?.start?.line;
    const text = [a.path ? `${a.path}${line ? `:${line}` : ''}` : undefined, a.title?.trim() || undefined, message].filter(Boolean).join(': ');
    return [text.length > MAX_CHECK_REPORTED_CHARS ? `${text.slice(0, MAX_CHECK_REPORTED_CHARS - 3)}...` : text];
  }).slice(0, MAX_CHECK_REPORTED);

/** Each check that failed (issue #927), with its link and what it reported, at most `MAX_FAILED_CHECKS`: what a `fix_checks` tend is told. */
const failedChecksOf = (r: Rollup | null | undefined): FailedCheck[] =>
  (r?.contexts?.nodes ?? []).flatMap((n): FailedCheck[] => {
    const name = n?.name ?? n?.context;
    const url = n?.detailsUrl ?? n?.targetUrl;
    if (!n || !name || !FAILED.has(n.conclusion ?? n.state ?? '')) return [];
    const reported = reportedOf(n);
    return [{ name, ...(url ? { url } : {}), ...(reported.length ? { reported } : {}) }];
  }).slice(0, MAX_FAILED_CHECKS);

/** Its head commit, base, the head's time and checks, when GitHub said; checks the app may not read: unknown (issue #855). */
const headOf = (n: Referenced, checksUnknown: boolean): { headCommittedAt?: string; checks?: ChecksState; failedChecks?: FailedCheck[]; headOid?: string; base?: string; headRef?: string } => {
  const commit = n.commits?.nodes?.at(-1)?.commit;
  const checks = rollupChecks(commit?.statusCheckRollup) ?? (checksUnknown && !commit?.statusCheckRollup ? 'unknown' : undefined);
  const failedChecks = failedChecksOf(commit?.statusCheckRollup);
  return {
    ...(commit?.committedDate ? { headCommittedAt: commit.committedDate } : {}), ...(checks ? { checks } : {}),
    ...(failedChecks.length ? { failedChecks } : {}),
    ...(n.headRefOid ? { headOid: n.headRefOid } : {}), ...(n.baseRefName ? { base: n.baseRefName } : {}),
    ...(n.headRefName ? { headRef: n.headRefName } : {}),
  };
};

/** Pull request `number`, or undefined when the number is an issue or names nothing. */
export function pullRequestFrom(body: unknown, what: string): NumberedPullRequest | undefined {
  const r = (body ?? {}) as GqlResponse;
  if (r.data?.repository && r.errors?.every((e) => e.type === 'NOT_FOUND')) return undefined;
  const r2 = response(body, what);
  const n = r2.data?.repository?.issueOrPullRequest;
  const state = PR_STATES[n?.state ?? ''];
  if (n?.__typename !== 'PullRequest' || !n.url || !n.createdAt || !state) return undefined;
  return {
    url: n.url, createdAt: n.createdAt, isDraft: n.isDraft === true, conflicting: n.mergeable === 'CONFLICTING', state,
    ...(n.mergedAt ? { mergedAt: n.mergedAt } : {}), ...headOf(n, r2.checksUnknown),
  };
}

export function openPullRequestsFrom(body: unknown, what: string): OpenPullRequest[] {
  const r = response(body, what);
  const nodes = r.data?.repository?.issue?.closedByPullRequestsReferences?.nodes ?? [];
  return nodes.flatMap((n) => n?.state === 'OPEN' && n.url && n.createdAt
    ? [{ url: n.url, createdAt: n.createdAt, isDraft: n.isDraft === true, conflicting: n.mergeable === 'CONFLICTING', ...headOf(n, r.checksUnknown) }] : []);
}

/** Each pull request that mentions the issue, once (the newest mention), any state. */
export function referencingPullRequestsFrom(body: unknown, what: string): ReferencingPullRequest[] {
  const r = response(body, what);
  const nodes = r.data?.repository?.issue?.timelineItems?.nodes ?? [];
  const byUrl = new Map<string, ReferencingPullRequest>();
  for (const n of nodes) {
    const s = n?.source;
    const state = PR_STATES[s?.state ?? ''];
    if (s?.__typename !== 'PullRequest' || !s.url || !s.createdAt || !state || !s.repository?.nameWithOwner) continue;
    byUrl.set(s.url, {
      url: s.url, createdAt: s.createdAt, isDraft: s.isDraft === true, conflicting: s.mergeable === 'CONFLICTING', ...headOf(s, r.checksUnknown), state,
      ...(s.mergedAt ? { mergedAt: s.mergedAt } : {}), body: s.body ?? '', repo: s.repository.nameWithOwner,
    });
  }
  return [...byUrl.values()];
}

/** The open pull requests of a repository, each with its branch (issue #637). */
export function repoPullRequestsFrom(body: unknown, what: string): BranchPullRequest[] {
  const r = response(body, what);
  const nodes = r.data?.repository?.pullRequests?.nodes ?? [];
  return nodes.flatMap((n) => n?.state === 'OPEN' && n.url && n.createdAt && n.headRefName
    ? [{ url: n.url, createdAt: n.createdAt, isDraft: n.isDraft === true, conflicting: n.mergeable === 'CONFLICTING', headRef: n.headRefName, body: n.body ?? '', ...headOf(n, r.checksUnknown) }] : []);
}

/**
 * An issue's cross-references (issue #430): the pull requests GitHub links as closing it, in any state
 * (`closedByPullRequestsReferences`), and its timeline's newest 100 cross-references, commit references and closes.
 */
export const CROSS_REFERENCES_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    closedByPullRequestsReferences(first: 50, includeClosedPrs: true) { nodes { url body repository { nameWithOwner } } }
    timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, REFERENCED_EVENT, CLOSED_EVENT], last: 100) { nodes {
      __typename
      ... on CrossReferencedEvent { source { __typename ... on PullRequest { url body repository { nameWithOwner } } } }
      ... on ReferencedEvent { commit { url message } commitRepository { nameWithOwner } }
      ... on ClosedEvent { closer { __typename ... on Commit { url message repository { nameWithOwner } } } }
    } }
  } }
}`;

interface Text { __typename?: string; url?: string; body?: string; message?: string; repository?: { nameWithOwner?: string } }
interface CrossData {
  data?: { repository?: { issue?: {
    closedByPullRequestsReferences?: { nodes?: (Text | null)[] };
    timelineItems?: { nodes?: ({ __typename?: string; source?: Text | null; commit?: Text | null; commitRepository?: { nameWithOwner?: string }; closer?: Text | null } | null)[] };
  } | null } | null };
}

/** The issue's cross-references as the port tells them: each mention once, by its URL; a GraphQL error throws. */
export function crossReferencesFrom(body: unknown, what: string): IssueCrossReferences {
  response(body, what);
  const issue = (body as CrossData).data?.repository?.issue;
  const mentions: Mention[] = [];
  const closing: IssueCrossReferences['closing'] = [];
  const mention = (kind: CrossReferenceKind, t: Text | null | undefined, repo: string | undefined, text: string | undefined): Mention | undefined => {
    if (!t?.url || !repo) return undefined;
    const m = { kind, repo, url: t.url, text: text ?? '' };
    if (!mentions.some((x) => x.url === m.url)) mentions.push(m);
    return m;
  };
  for (const pr of issue?.closedByPullRequestsReferences?.nodes ?? []) {
    const m = mention('pull_request', pr, pr?.repository?.nameWithOwner, pr?.body);
    if (m) closing.push({ kind: m.kind, repo: m.repo, url: m.url });
  }
  for (const n of issue?.timelineItems?.nodes ?? []) {
    if (n?.__typename === 'CrossReferencedEvent' && n.source?.__typename === 'PullRequest') mention('pull_request', n.source, n.source.repository?.nameWithOwner, n.source.body);
    if (n?.__typename === 'ReferencedEvent') mention('commit', n.commit, n.commitRepository?.nameWithOwner, n.commit?.message);
    if (n?.__typename === 'ClosedEvent' && n.closer?.__typename === 'Commit') {
      const m = mention('commit', n.closer, n.closer.repository?.nameWithOwner, n.closer.message);
      if (m && !closing.some((c) => c.url === m.url)) closing.push({ kind: m.kind, repo: m.repo, url: m.url });
    }
  }
  return { mentions, closing };
}
