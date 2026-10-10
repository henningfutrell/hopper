// The pull requests of an issue, over GraphQL, shared by the App and the connected account adapters: what
// closed it (the last ClosedEvent's closer — only a merged pull request counts; a person, a commit
// or a project closing it is undefined), and the open pull requests whose merge will close it
// (`closedByPullRequestsReferences`: a closing keyword, on a pull request to the default branch), and the pull
// requests that mention it in any state (the issue's cross-references, issue #579: a part says "Part of #N"), and a pull
// request by its number (issue #618: one an issue names to update). Each says when its head commit was made.

import { GitHubApiError } from './api.ts';
import type { ClosingPullRequest, NumberedPullRequest, OpenPullRequest, ReferencingPullRequest } from './api.ts';

/** A pull request's head commit, and when it was made (issue #618). */
const HEAD_COMMIT = 'commits(last: 1) { nodes { commit { committedDate } } }';

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
    __typename ... on PullRequest { url createdAt isDraft state mergeable mergedAt ${HEAD_COMMIT} }
  } }
}`;

interface Closer { __typename?: string; url?: string; createdAt?: string; mergedAt?: string | null }
interface Referenced {
  url?: string; createdAt?: string; isDraft?: boolean; state?: string; mergeable?: string;
  commits?: { nodes?: ({ commit?: { committedDate?: string } } | null)[] };
}
interface Numbered extends Referenced { __typename?: string; mergedAt?: string | null }
interface Source extends Referenced { __typename?: string; body?: string; mergedAt?: string | null; repository?: { nameWithOwner?: string } }
const PR_STATES: Record<string, ReferencingPullRequest['state']> = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };
interface GqlResponse {
  data?: { repository?: { issueOrPullRequest?: Numbered | null; issue?: {
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

/** Its head commit's time, when GitHub said. */
const headOf = (n: Referenced): { headCommittedAt?: string } => {
  const at = n.commits?.nodes?.at(-1)?.commit?.committedDate;
  return at ? { headCommittedAt: at } : {};
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
    ...(n.mergedAt ? { mergedAt: n.mergedAt } : {}), ...headOf(n),
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
