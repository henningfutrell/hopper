// The pull requests of an issue, over GraphQL, shared by the App and the connected account adapters: what
// closed it (the last ClosedEvent's closer — only a merged pull request counts; a person, a commit
// or a project closing it is undefined), and the open pull requests whose merge will close it
// (`closedByPullRequestsReferences`: a closing keyword, on a pull request to the default branch).

import { GitHubApiError } from './api.ts';
import type { ClosingPullRequest, OpenPullRequest } from './api.ts';

export const CLOSING_PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent {
      closer { __typename ... on PullRequest { url createdAt mergedAt } }
    } } }
  } }
}`;

export const OPEN_PULL_REQUESTS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    closedByPullRequestsReferences(first: 50, includeClosedPrs: false) { nodes { url createdAt isDraft state } }
  } }
}`;

interface Closer { __typename?: string; url?: string; createdAt?: string; mergedAt?: string | null }
interface Referenced { url?: string; createdAt?: string; isDraft?: boolean; state?: string }
interface GqlResponse {
  data?: { repository?: { issue?: {
    timelineItems?: { nodes?: ({ closer?: Closer | null } | null)[] };
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

export function openPullRequestsFrom(body: unknown, what: string): OpenPullRequest[] {
  const nodes = response(body, what).data?.repository?.issue?.closedByPullRequestsReferences?.nodes ?? [];
  return nodes.flatMap((n) => n?.state === 'OPEN' && n.url && n.createdAt
    ? [{ url: n.url, createdAt: n.createdAt, isDraft: n.isDraft === true }] : []);
}
