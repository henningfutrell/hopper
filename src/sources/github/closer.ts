// The pull requests of an issue, over GraphQL, shared by the App and the connected account adapters: what
// closed it (the last ClosedEvent's closer — only a merged pull request counts; a person, a commit
// or a project closing it is undefined), and the open pull requests whose merge will close it
// (`closedByPullRequestsReferences`: a closing keyword, on a pull request to the default branch), and the pull
// requests that mention it in any state (the issue's cross-references, issue #579: a part says "Part of #N"), and a pull
// request by its number (issue #618: one an issue names to update), and the open pull requests of a repository with their
// branches (issue #637: one named for an issue). Each says when its head commit was made, and its checks (issue #637). And
// an issue's cross-references (issue #430): the pull requests and commits that mention it, with their text, and the ones
// GitHub links as closing it.

import { GitHubApiError } from './api.ts';
import type { BranchPullRequest, ClosingPullRequest, NumberedPullRequest, OpenPullRequest, ReferencingPullRequest } from './api.ts';
import type { ChecksState } from '../../domain/pull-requests.ts';
import type { CrossReferenceKind, IssueCrossReferences, Mention } from '../../domain/cross-references.ts';

/** A pull request's head commit, when it was made (issue #618), and its checks (issue #637). */
const HEAD_COMMIT = 'commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }';

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
    __typename ... on PullRequest { url createdAt isDraft state mergeable mergedAt baseRefName ${HEAD_COMMIT} }
  } }
}`;

export const OPEN_REPO_PULL_REQUESTS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: [OPEN], first: 100, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { url createdAt isDraft state mergeable headRefName body ${HEAD_COMMIT} } }
  }
}`;

interface Closer { __typename?: string; url?: string; createdAt?: string; mergedAt?: string | null }
interface Referenced {
  url?: string; createdAt?: string; isDraft?: boolean; state?: string; mergeable?: string;
  commits?: { nodes?: ({ commit?: { committedDate?: string; statusCheckRollup?: { state?: string } | null } } | null)[] };
  headRefName?: string;
  body?: string;
}
interface Numbered extends Referenced { __typename?: string; mergedAt?: string | null; baseRefName?: string }
interface Source extends Referenced { __typename?: string; body?: string; mergedAt?: string | null; repository?: { nameWithOwner?: string } }
const PR_STATES: Record<string, ReferencingPullRequest['state']> = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };
interface GqlResponse {
  data?: { repository?: { issueOrPullRequest?: Numbered | null; pullRequests?: { nodes?: (Referenced | null)[] }; issue?: {
    timelineItems?: { nodes?: ({ closer?: Closer | null; source?: Source | null } | null)[] };
    closedByPullRequestsReferences?: { nodes?: (Referenced | null)[] };
  } | null } | null };
  errors?: { type?: string; message?: string }[];
}

const PERMANENT_TYPES = new Set(['NOT_FOUND', 'FORBIDDEN']);

/** Throws a GitHubApiError for a GraphQL error (NOT_FOUND/FORBIDDEN permanent, the rest transient). */
function response(body: unknown, what: string): GqlResponse {
  const r = (body ?? {}) as GqlResponse;
  if (r.errors?.length) {
    const message = `${what}: ${r.errors.map((e) => e.message ?? e.type ?? 'error').join('; ')}`;
    throw new GitHubApiError(message, r.errors.some((e) => PERMANENT_TYPES.has(e.type ?? '')));
  }
  return r;
}

export function closingPullRequestFrom(body: unknown, what: string): ClosingPullRequest | undefined {
  const r = response(body, what);
  const c = r.data?.repository?.issue?.timelineItems?.nodes?.at(-1)?.closer;
  if (c?.__typename !== 'PullRequest' || !c.url || !c.createdAt || !c.mergedAt) return undefined;
  return { url: c.url, createdAt: c.createdAt, mergedAt: c.mergedAt };
}

/** GitHub's rollup state as the port's checks: none (no checks) is absent. */
const CHECKS: Record<string, ChecksState> = { SUCCESS: 'passing', PENDING: 'pending', EXPECTED: 'pending', FAILURE: 'failing', ERROR: 'failing' };

/** Its head commit's time and checks, when GitHub said. */
const headOf = (n: Referenced): { headCommittedAt?: string; checks?: ChecksState } => {
  const commit = n.commits?.nodes?.at(-1)?.commit;
  const checks = CHECKS[commit?.statusCheckRollup?.state ?? ''];
  return { ...(commit?.committedDate ? { headCommittedAt: commit.committedDate } : {}), ...(checks ? { checks } : {}) };
};

/** Pull request `number`, or undefined when the number is an issue or names nothing. */
export function pullRequestFrom(body: unknown, what: string): NumberedPullRequest | undefined {
  const r = (body ?? {}) as GqlResponse;
  if (r.data?.repository && r.errors?.every((e) => e.type === 'NOT_FOUND')) return undefined;
  const n = response(body, what).data?.repository?.issueOrPullRequest;
  const state = PR_STATES[n?.state ?? ''];
  if (n?.__typename !== 'PullRequest' || !n.url || !n.createdAt || !state) return undefined;
  return {
    url: n.url, createdAt: n.createdAt, isDraft: n.isDraft === true, conflicting: n.mergeable === 'CONFLICTING', state,
    ...(n.mergedAt ? { mergedAt: n.mergedAt } : {}), ...(n.baseRefName ? { base: n.baseRefName } : {}), ...headOf(n),
  };
}

export function openPullRequestsFrom(body: unknown, what: string): OpenPullRequest[] {
  const nodes = response(body, what).data?.repository?.issue?.closedByPullRequestsReferences?.nodes ?? [];
  return nodes.flatMap((n) => n?.state === 'OPEN' && n.url && n.createdAt
    ? [{ url: n.url, createdAt: n.createdAt, isDraft: n.isDraft === true, conflicting: n.mergeable === 'CONFLICTING', ...headOf(n) }] : []);
}

/** Each pull request that mentions the issue, once (the newest mention), any state. */
export function referencingPullRequestsFrom(body: unknown, what: string): ReferencingPullRequest[] {
  const nodes = response(body, what).data?.repository?.issue?.timelineItems?.nodes ?? [];
  const byUrl = new Map<string, ReferencingPullRequest>();
  for (const n of nodes) {
    const s = n?.source;
    const state = PR_STATES[s?.state ?? ''];
    if (s?.__typename !== 'PullRequest' || !s.url || !s.createdAt || !state || !s.repository?.nameWithOwner) continue;
    byUrl.set(s.url, {
      url: s.url, createdAt: s.createdAt, isDraft: s.isDraft === true, conflicting: s.mergeable === 'CONFLICTING', ...headOf(s), state,
      ...(s.mergedAt ? { mergedAt: s.mergedAt } : {}), body: s.body ?? '', repo: s.repository.nameWithOwner,
    });
  }
  return [...byUrl.values()];
}

/** The open pull requests of a repository, each with its branch (issue #637). */
export function repoPullRequestsFrom(body: unknown, what: string): BranchPullRequest[] {
  const nodes = response(body, what).data?.repository?.pullRequests?.nodes ?? [];
  return nodes.flatMap((n) => n?.state === 'OPEN' && n.url && n.createdAt && n.headRefName
    ? [{ url: n.url, createdAt: n.createdAt, isDraft: n.isDraft === true, conflicting: n.mergeable === 'CONFLICTING', headRef: n.headRefName, body: n.body ?? '', ...headOf(n) }] : []);
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
