// An issue's place for the issue graph (issue #437), over GraphQL, shared by the App and the connected account adapters:
// its repository's owner, the Projects (v2) it is an item of, the pull requests whose merge closes it (any state), the
// issues and pull requests that mention it (its cross-references), its parent and its sub-issues. One query per issue.
// A token that cannot read a part (an installation token and a user's Project) leaves that part out: GitHub answers the
// rest with an error beside it.

import { GitHubApiError } from './api.ts';
import type { IssuePlace, ItemRef } from '../../domain/issue-graph.ts';

const ITEM = 'url number state repository { nameWithOwner }';

export const ISSUE_PLACE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    owner { __typename login }
    issue(number: $number) {
      url number title state updatedAt
      parent { ${ITEM} }
      subIssues(first: 50) { nodes { ${ITEM} } }
      projectItems(first: 50) { nodes { project { number title url owner { __typename ... on Organization { login } ... on User { login } } } } }
      closedByPullRequestsReferences(first: 50, includeClosedPrs: true) { nodes { ${ITEM} } }
      timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 100) { nodes { ... on CrossReferencedEvent {
        source { __typename ... on Issue { ${ITEM} } ... on PullRequest { ${ITEM} } }
      } } }
    }
  }
}`;

interface Item { __typename?: string; url?: string; number?: number; state?: string; repository?: { nameWithOwner?: string } }
interface Nodes<T> { nodes?: (T | null)[] }
interface PlaceData {
  repository?: {
    owner?: { __typename?: string; login?: string };
    issue?: {
      url?: string; number?: number; title?: string; state?: string; updatedAt?: string;
      parent?: Item | null;
      subIssues?: Nodes<Item>;
      projectItems?: Nodes<{ project?: { number?: number; title?: string; url?: string; owner?: { login?: string } } | null }>;
      closedByPullRequestsReferences?: Nodes<Item>;
      timelineItems?: Nodes<{ source?: Item | null }>;
    } | null;
  } | null;
}

const ref = (kind: ItemRef['kind'], i: Item | null | undefined): ItemRef[] =>
  i?.url && i.number !== undefined && i.repository?.nameWithOwner
    ? [{ kind, repo: i.repository.nameWithOwner, number: i.number, url: i.url, ...(i.state ? { state: i.state.toLowerCase() } : {}) }]
    : [];
const nodes = <T>(n: Nodes<T> | undefined): T[] => (n?.nodes ?? []).filter((x): x is T => x != null);

/** The place GitHub answered, or a GitHubApiError naming `what` when it answered no issue. */
export function issuePlaceFrom(body: unknown, what: string): IssuePlace {
  const b = body as { data?: PlaceData; errors?: { type?: string; message?: string }[] } | undefined;
  const repo = b?.data?.repository;
  const issue = repo?.issue;
  const name = issue?.url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\//)?.[1];
  if (!repo?.owner?.login || !issue?.url || issue.number === undefined || !name) {
    const errors = b?.errors ?? [];
    throw new GitHubApiError(`${what}: ${errors.map((e) => e.message ?? e.type).join('; ') || 'no issue'}`, errors.some((e) => e.type === 'NOT_FOUND'));
  }
  const type = repo.owner.__typename;
  const parent = ref('issue', issue.parent)[0];
  return {
    issue: { repo: name, number: issue.number, url: issue.url, title: issue.title ?? '', state: (issue.state ?? '').toLowerCase(), updatedAt: issue.updatedAt ?? '' },
    owner: { login: repo.owner.login, ...(type === 'Organization' || type === 'User' ? { type } : {}) },
    projects: nodes(issue.projectItems).flatMap(({ project: p }) => (p?.url && p.number !== undefined && p.owner?.login
      ? [{ owner: p.owner.login, number: p.number, url: p.url, ...(p.title ? { title: p.title } : {}) }] : [])),
    closedBy: nodes(issue.closedByPullRequestsReferences).flatMap((p) => ref('pull_request', p)),
    references: nodes(issue.timelineItems).flatMap(({ source: s }) =>
      ref(s?.__typename === 'PullRequest' ? 'pull_request' : 'issue', s?.__typename === 'PullRequest' || s?.__typename === 'Issue' ? s : undefined)),
    ...(parent ? { parent } : {}),
    subIssues: nodes(issue.subIssues).flatMap((s) => ref('issue', s)),
  };
}
