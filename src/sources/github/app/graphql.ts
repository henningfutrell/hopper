// Projects (v2) items over GraphQL with an installation token. Tried as an organization project,
// then as a user project. Installation tokens can read organization projects
// (`organization_projects: read`); user-owned projects need a personal token, so for those this
// ends in a permanent error and the source falls back to labels (projectErrors). Also: the pull
// request that closed an issue, and the open ones whose merge will close it (closer.ts).

import type { ClosingPullRequest, GitHubProjectItem, OpenPullRequest, ReferencingPullRequest } from '../api.ts';
import { GitHubApiError } from '../api.ts';
import { CLOSING_PULL_REQUEST_QUERY, OPEN_PULL_REQUESTS_QUERY, REFERENCING_PULL_REQUESTS_QUERY, closingPullRequestFrom, openPullRequestsFrom, referencingPullRequestsFrom } from '../closer.ts';
import { splitRepo } from './http.ts';
import type { Request } from './http.ts';

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

export async function closingPullRequest(req: Request, token: string, repo: string, number: number): Promise<ClosingPullRequest | undefined> {
  const { owner, repo: name } = splitRepo(repo);
  const r = await req('POST /graphql', {
    query: CLOSING_PULL_REQUEST_QUERY, variables: { owner, name, number }, headers: { authorization: `token ${token}` },
  });
  return closingPullRequestFrom(r.data, `closer of ${repo}#${number}`);
}

export async function openClosingPullRequests(req: Request, token: string, repo: string, number: number): Promise<OpenPullRequest[]> {
  const { owner, repo: name } = splitRepo(repo);
  const r = await req('POST /graphql', {
    query: OPEN_PULL_REQUESTS_QUERY, variables: { owner, name, number }, headers: { authorization: `token ${token}` },
  });
  return openPullRequestsFrom(r.data, `pull requests of ${repo}#${number}`);
}

export async function referencingPullRequests(req: Request, token: string, repo: string, number: number): Promise<ReferencingPullRequest[]> {
  const { owner, repo: name } = splitRepo(repo);
  const r = await req('POST /graphql', {
    query: REFERENCING_PULL_REQUESTS_QUERY, variables: { owner, name, number }, headers: { authorization: `token ${token}` },
  });
  return referencingPullRequestsFrom(r.data, `pull requests mentioning ${repo}#${number}`);
}
