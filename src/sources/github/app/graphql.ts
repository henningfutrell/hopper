// Projects (v2) items over GraphQL with an installation token. Tried as an organization project,
// then as a user project. Installation tokens can read organization projects
// (`organization_projects: read`); user-owned projects need a personal token, so for those this
// ends in a permanent error and the source falls back to labels (projectErrors). Also: the pull
// request that closed an issue, the open ones whose merge will close it, a pull request by its number, and the open
// pull requests of a repository, and an issue's cross-references (issue #430) (closer.ts).
// And an issue's place for the issue graph (issue-place.ts, issue #437). The reads of one issue or pull request go through
// `ask` (graphql-batch.ts, issue #822): the ones asked at the same time are one request.

import type { BranchPullRequest, ClosingPullRequest, GitHubProjectItem, NumberedPullRequest, OpenPullRequest, ReferencingPullRequest } from '../api.ts';
import { GitHubApiError } from '../api.ts';
import type { ItemEdit } from '../../../domain/item-snapshots.ts';
import {
  CLOSING_PULL_REQUEST_QUERY, CROSS_REFERENCES_QUERY, OPEN_PULL_REQUESTS_QUERY, OPEN_REPO_PULL_REQUESTS_QUERY, PULL_REQUEST_QUERY, REFERENCING_PULL_REQUESTS_QUERY, closingPullRequestFrom, openPullRequestsFrom, pullRequestFrom,
  crossReferencesFrom, referencingPullRequestsFrom, repoPullRequestsFrom,
} from '../closer.ts';
import type { IssueCrossReferences } from '../../../domain/cross-references.ts';
import { ISSUE_PLACE_QUERY, issuePlaceFrom } from '../issue-place.ts';
import type { IssuePlace } from '../../../domain/issue-graph.ts';
import { splitRepo } from './http.ts';
import type { Request } from './http.ts';
import type { AskGraphQL } from './graphql-batch.ts';

const MAX_PAGES = 50;
const named = (value: string) => `${value} field { ... on ProjectV2FieldCommon { name } }`;
const FIELD_VALUES = `fieldValues(first: 50) { nodes {
  ... on ProjectV2ItemFieldSingleSelectValue { ${named('name')} }
  ... on ProjectV2ItemFieldTextValue { ${named('text')} }
  ... on ProjectV2ItemFieldNumberValue { ${named('number')} }
  ... on ProjectV2ItemFieldIterationValue { ${named('title')} }
  ... on ProjectV2ItemFieldDateValue { ${named('date')} }
} }`;

type OwnerKind = 'organization' | 'user';

const query = (kind: OwnerKind) => `query($login: String!, $number: Int!, $first: Int!, $after: String) {
  ${kind}(login: $login) { projectV2(number: $number) { items(first: $first, after: $after) {
    nodes { content { ... on Issue { url } } ${FIELD_VALUES} }
    pageInfo { hasNextPage endCursor }
  } } }
}`;

interface FieldNode { field?: { name?: string }; name?: string; text?: string; number?: number; title?: string; date?: string }
interface ItemNode { content?: { url?: string } | null; fieldValues?: { nodes?: (FieldNode | null)[] } }
interface Items { nodes?: (ItemNode | null)[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }
interface GqlResponse {
  data?: Record<string, { projectV2?: { items?: Items } | null } | null>;
  errors?: { type?: string; message?: string }[];
}

function fieldsOf(node: ItemNode): Record<string, string | number> {
  const fields: Record<string, string | number> = {};
  for (const f of node.fieldValues?.nodes ?? []) {
    const key = f?.field?.name?.toLowerCase();
    const value = f?.name ?? f?.text ?? f?.number ?? f?.title ?? f?.date;
    if (key && value !== undefined) fields[key] = value;
  }
  return fields;
}

type Read = { items: GitHubProjectItem[] } | { error: string; forbidden: boolean };

async function readAs(req: Request, token: string, kind: OwnerKind, login: string, number: number): Promise<Read> {
  const items: GitHubProjectItem[] = [];
  let after: string | null = null;
  let index = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await req('POST /graphql', {
      query: query(kind), variables: { login, number, first: 100, after }, headers: { authorization: `token ${token}` },
    });
    const body = r.data as GqlResponse;
    const got = body.data?.[kind]?.projectV2?.items;
    if (body.errors?.length || !got) {
      const errors = body.errors ?? [];
      const error = errors.map((e) => e.message ?? e.type ?? 'error').join('; ') || 'no project';
      return { error, forbidden: errors.some((e) => e.type === 'FORBIDDEN') };
    }
    for (const node of got.nodes ?? []) {
      if (!node) continue;
      const url = node.content?.url;
      if (url) items.push({ url, index, fields: fieldsOf(node) });
      index++;
    }
    if (!got.pageInfo?.hasNextPage || !got.pageInfo.endCursor) break;
    after = got.pageInfo.endCursor;
  }
  return { items };
}

export async function projectItems(req: Request, token: string, owner: string, number: number): Promise<GitHubProjectItem[]> {
  const org = await readAs(req, token, 'organization', owner, number);
  if ('items' in org) return org.items;
  const user = await readAs(req, token, 'user', owner, number);
  if ('items' in user) return user.items;
  const hint = user.forbidden ? ' (a GitHub App installation token cannot read user-owned Projects; priority comes from labels)' : '';
  throw new GitHubApiError(`project ${owner}/projects/${number}: organization: ${org.error}; user: ${user.error}${hint}`, true);
}

export async function closingPullRequest(ask: AskGraphQL, token: string, repo: string, number: number): Promise<ClosingPullRequest | undefined> {
  return closingPullRequestFrom(await ask(token, CLOSING_PULL_REQUEST_QUERY, repo, number), `closer of ${repo}#${number}`);
}

export async function openClosingPullRequests(ask: AskGraphQL, token: string, repo: string, number: number): Promise<OpenPullRequest[]> {
  return openPullRequestsFrom(await ask(token, OPEN_PULL_REQUESTS_QUERY, repo, number), `pull requests of ${repo}#${number}`);
}

export async function referencingPullRequests(ask: AskGraphQL, token: string, repo: string, number: number): Promise<ReferencingPullRequest[]> {
  return referencingPullRequestsFrom(await ask(token, REFERENCING_PULL_REQUESTS_QUERY, repo, number), `pull requests mentioning ${repo}#${number}`);
}

export async function crossReferences(ask: AskGraphQL, token: string, repo: string, number: number): Promise<IssueCrossReferences> {
  return crossReferencesFrom(await ask(token, CROSS_REFERENCES_QUERY, repo, number), `cross-references of ${repo}#${number}`);
}

export async function pullRequest(ask: AskGraphQL, token: string, repo: string, number: number): Promise<NumberedPullRequest | undefined> {
  return pullRequestFrom(await ask(token, PULL_REQUEST_QUERY, repo, number), `pull request ${repo}#${number}`);
}

export async function openPullRequests(req: Request, token: string, repo: string): Promise<BranchPullRequest[]> {
  const { owner, repo: name } = splitRepo(repo);
  const r = await req('POST /graphql', {
    query: OPEN_REPO_PULL_REQUESTS_QUERY, variables: { owner, name }, headers: { authorization: `token ${token}` },
  });
  return repoPullRequestsFrom(r.data, `open pull requests of ${repo}`);
}

/** Who edited an issue's body (its content edits) and title (its renames), the newest 50 of each (issue #662). */
const ISSUE_EDITS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) {
    userContentEdits(last: 50) { nodes { editedAt editor { login } } }
    timelineItems(itemTypes: [RENAMED_TITLE_EVENT], last: 50) { nodes { ... on RenamedTitleEvent { createdAt actor { login } } } }
  } }
}`;

interface EditsData {
  repository?: { issue?: {
    userContentEdits?: { nodes?: ({ editedAt?: string; editor?: { login?: string } | null } | null)[] };
    timelineItems?: { nodes?: ({ createdAt?: string; actor?: { login?: string } | null } | null)[] };
  } | null } | null;
}

/** The edits of an issue's title and body, oldest first; an editor GitHub no longer names is `ghost`. */
export function issueEditsFrom(data: unknown): ItemEdit[] {
  const issue = (data as EditsData | undefined)?.repository?.issue;
  const edits: ItemEdit[] = [
    ...(issue?.userContentEdits?.nodes ?? []).filter((n) => n?.editedAt).map((n) => ({ what: 'body' as const, editor: n!.editor?.login ?? 'ghost', at: n!.editedAt! })),
    ...(issue?.timelineItems?.nodes ?? []).filter((n) => n?.createdAt).map((n) => ({ what: 'title' as const, editor: n!.actor?.login ?? 'ghost', at: n!.createdAt! })),
  ];
  return edits.sort((a, b) => a.at.localeCompare(b.at));
}

export async function issueEdits(ask: AskGraphQL, token: string, repo: string, number: number): Promise<ItemEdit[]> {
  return issueEditsFrom(await ask(token, ISSUE_EDITS_QUERY, repo, number));
}

export async function issuePlace(ask: AskGraphQL, token: string, repo: string, number: number): Promise<IssuePlace> {
  return issuePlaceFrom(await ask(token, ISSUE_PLACE_QUERY, repo, number), `place of ${repo}#${number}`);
}
