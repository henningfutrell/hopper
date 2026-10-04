// What closed an issue, over GraphQL: the last ClosedEvent's closer. Shared by the gh CLI and the
// App adapters. Only a merged pull request counts; a person, a commit or a project closing it is
// undefined.

import { GitHubApiError } from './api.ts';
import type { ClosingPullRequest } from './api.ts';

export const CLOSING_PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent {
      closer { __typename ... on PullRequest { url createdAt mergedAt } }
    } } }
  } }
}`;

interface Closer { __typename?: string; url?: string; createdAt?: string; mergedAt?: string | null }
interface GqlResponse {
  data?: { repository?: { issue?: { timelineItems?: { nodes?: ({ closer?: Closer | null } | null)[] } } | null } | null };
  errors?: { type?: string; message?: string }[];
}

const PERMANENT_TYPES = new Set(['NOT_FOUND', 'FORBIDDEN']);

/** Throws a GitHubApiError for a GraphQL error (NOT_FOUND/FORBIDDEN permanent, the rest transient). */
export function closingPullRequestFrom(body: unknown, what: string): ClosingPullRequest | undefined {
  const r = (body ?? {}) as GqlResponse;
  if (r.errors?.length) {
    const message = `${what}: ${r.errors.map((e) => e.message ?? e.type ?? 'error').join('; ')}`;
    throw new GitHubApiError(message, r.errors.some((e) => PERMANENT_TYPES.has(e.type ?? '')));
  }
  const c = r.data?.repository?.issue?.timelineItems?.nodes?.at(-1)?.closer;
  if (c?.__typename !== 'PullRequest' || !c.url || !c.createdAt || !c.mergedAt) return undefined;
  return { url: c.url, createdAt: c.createdAt, mergedAt: c.mergedAt };
}
