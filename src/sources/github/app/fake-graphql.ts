// POST /graphql of the fake GitHub: `organization(login).projectV2(number)` and
// `user(login).projectV2(number)` items, behaving as GitHub does for an installation token:
// organization projects are readable; a user-owned project is FORBIDDEN ("Resource not
// accessible by integration"); a login of the other kind is NOT_FOUND. Also
// `repository(owner, name).issue(number)`: the pull request whose merge closed the issue, and the
// open ones whose merge will close it. And `repository(owner, name).issueOrPullRequest(number)` (issue #618): a pull
// request any issue of the repo knows, by its number; an issue; or NOT_FOUND. And an issue's cross-references (issue
// #430): its closing pull requests — the open ones and the merged one that closed it — and the pull requests that mention it.
// And an issue's place (issue #437).

import { tokenReaches } from './fake-routes.ts';
import type { FakeCtx, FakeReply, FakeReq } from './fake-routes.ts';
import type { FakeIssue, FakePullRequest, FakeRepo } from './fake-state.ts';

interface GqlBody {
  query?: string;
  variables?: { login?: string; owner?: string; name?: string; number?: number; first?: number; after?: string | null };
}

/** GraphQL's head commit of a pull request: when it was made. */
const withHead = <P extends FakePullRequest>({ headCommittedAt, ...p }: P) =>
  ({ ...p, commits: { nodes: headCommittedAt ? [{ commit: { committedDate: headCommittedAt } }] : [] } });

/** `repository(owner, name).issue(number)` last ClosedEvent: its closer, a pull request or none. */
function closer(ctx: FakeCtx, req: FakeReq, b: GqlBody): FakeReply {
  const repo = ctx.state.repos.get(`${b.variables?.owner}/${b.variables?.name}`);
  if (!repo || !tokenReaches(req.token!, repo)) {
    return { status: 200, body: { data: { repository: null }, errors: [{ type: 'NOT_FOUND', path: ['repository'], message: 'Could not resolve to a Repository.' }] } };
  }
  if (/issueOrPullRequest/.test(b.query ?? '')) {
    const n = Number(b.variables?.number);
    const url = `https://github.com/${repo.owner}/${repo.name}/pull/${n}`;
    const all = [...repo.issues.values()].flatMap((i) => [...i.openPullRequests.map((p) => ({ ...p, state: 'OPEN' })), ...i.mentionedBy]);
    const pr = all.find((p) => p.url === url);
    if (pr) {
      const { body: _b, repo: _r, ...rest } = pr as typeof pr & { body?: string; repo?: string };
      return { status: 200, body: { data: { repository: { issueOrPullRequest: { __typename: 'PullRequest', ...withHead(rest) } } } } };
    }
    if (repo.issues.has(n)) return { status: 200, body: { data: { repository: { issueOrPullRequest: { __typename: 'Issue' } } } } };
    return { status: 200, body: { data: { repository: { issueOrPullRequest: null } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'issueOrPullRequest'], message: `Could not resolve to an issue or pull request with the number of ${n}.` }] } };
  }
  const issue = repo.issues.get(Number(b.variables?.number));
  if (!issue) return { status: 200, body: { data: { repository: { issue: null } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'issue'], message: 'Could not resolve to an Issue.' }] } };
  if (/commitRepository/.test(b.query ?? '')) {
    const repository = { nameWithOwner: `${repo.owner}/${repo.name}` };
    const closing = [...issue.openPullRequests, ...(issue.closedByPullRequest ? [issue.closedByPullRequest] : [])].map((p) => ({ url: p.url, body: issue.mentionedBy.find((m) => m.url === p.url)?.body ?? '', repository }));
    const nodes = issue.mentionedBy.map((m) => ({ __typename: 'CrossReferencedEvent', source: { __typename: 'PullRequest', url: m.url, body: m.body, repository: { nameWithOwner: m.repo } } }));
    return { status: 200, body: { data: { repository: { issue: { closedByPullRequestsReferences: { nodes: closing }, timelineItems: { nodes } } } } } };
  }
  if (/subIssues/.test(b.query ?? '')) return { status: 200, body: { data: { repository: place(ctx, repo, issue) } } };
  if (/CROSS_REFERENCED_EVENT/.test(b.query ?? '')) {
    const nodes = issue.mentionedBy.map(({ repo: nameWithOwner, ...m }) => ({ source: { __typename: 'PullRequest', ...withHead(m), repository: { nameWithOwner } } }));
    return { status: 200, body: { data: { repository: { issue: { timelineItems: { nodes } } } } } };
  }
  if (/closedByPullRequestsReferences/.test(b.query ?? '')) {
    const open = issue.openPullRequests.map((p) => ({ ...withHead(p), state: 'OPEN' }));
    return { status: 200, body: { data: { repository: { issue: { closedByPullRequestsReferences: { nodes: open } } } } } };
  }
  const pr = issue.closedByPullRequest;
  const nodes = issue.state !== 'closed' ? [] : [{ closer: pr ? { __typename: 'PullRequest', ...pr } : null }];
  return { status: 200, body: { data: { repository: { issue: { timelineItems: { nodes } } } } } };
}

/** An issue's place (issue #437): its owner, the projects naming it, its open closing pull requests and its mentions. */
function place(ctx: FakeCtx, repo: FakeRepo, issue: FakeIssue) {
  const url = `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
  const type = ctx.state.installations.find((i) => i.account === repo.owner)?.accountType ?? 'User';
  const item = (p: { url: string; state?: string; repo?: string }) =>
    ({ url: p.url, number: Number(p.url.slice(p.url.lastIndexOf('/') + 1)), state: p.state ?? 'OPEN', repository: { nameWithOwner: p.repo ?? `${repo.owner}/${repo.name}` } });
  const projects = ctx.state.projects.filter((p) => p.items.some((it) => it.url === url))
    .map((p) => ({ project: { number: p.number, url: `https://github.com/orgs/${p.owner}/projects/${p.number}`, owner: { login: p.owner } } }));
  return {
    owner: { __typename: type, login: repo.owner },
    issue: {
      url, number: issue.number, title: issue.title, state: issue.state.toUpperCase(), updatedAt: issue.updatedAt, parent: null, subIssues: { nodes: [] },
      projectItems: { nodes: projects }, closedByPullRequestsReferences: { nodes: issue.openPullRequests.map(item) },
      timelineItems: { nodes: issue.mentionedBy.map((m) => ({ source: { __typename: 'PullRequest', ...item(m) } })) },
    },
  };
}

function fieldNode(name: string, value: string | number) {
  return typeof value === 'number' ? { number: value, field: { name } } : { name: value, field: { name } };
}

/** The text from `open` (a `{`) to its matching `}`. */
function blockAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

/**
 * A batched read (issue #822): `q<i>: repository(owner: $o<i>, name: $n<i>) { … $k<i> … }` aliases, each answered as its own
 * query would be, its errors' paths under its alias. The requests the fake saw show how many went.
 */
function batched(ctx: FakeCtx, req: FakeReq, b: GqlBody): FakeReply {
  const query = b.query ?? '';
  const vars = (b.variables ?? {}) as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  const errors: { path?: unknown[] }[] = [];
  for (const m of query.matchAll(/(q(\d+)): repository\(owner: \$o\d+, name: \$n\d+\) \{/g)) {
    const [, alias, i] = m as unknown as [string, string, string];
    const selection = blockAt(query, m.index + m[0].length - 1);
    const one = { query: `repository(owner: $owner, name: $name) ${selection}`, variables: { owner: vars[`o${i}`], name: vars[`n${i}`], number: vars[`k${i}`] } } as GqlBody;
    const body = closer(ctx, req, one).body as { data?: { repository?: unknown }; errors?: { path?: unknown[] }[] };
    data[alias] = body.data?.repository ?? null;
    for (const e of body.errors ?? []) errors.push({ ...e, path: [alias, ...(e.path ?? []).slice(1)] });
  }
  return { status: 200, body: { data, ...(errors.length ? { errors } : {}) } };
}

export function graphql(ctx: FakeCtx, req: FakeReq): FakeReply {
  const b = (req.body ?? {}) as GqlBody;
  const query = b.query ?? '';
  if (/q0: repository\(owner/.test(query)) return batched(ctx, req, b);
  if (/repository\(owner/.test(query)) return closer(ctx, req, b);
  const login = b.variables?.login ?? '';
  const number = Number(b.variables?.number);
  const kind = /organization\(login/.test(query) ? 'organization' : /user\(login/.test(query) ? 'user' : undefined;
  if (!kind) return { status: 200, body: { errors: [{ message: 'fake GitHub: unsupported query' }] } };
  const account = ctx.state.installations.find((i) => i.account === login);
  const isOrg = (account?.accountType ?? 'User') === 'Organization';
  if (kind === 'organization' && !(account && isOrg)) {
    return { status: 200, body: { data: { organization: null }, errors: [{ type: 'NOT_FOUND', path: ['organization'], message: `Could not resolve to an Organization with the login of '${login}'.` }] } };
  }
  if (kind === 'user') {
    if (account && !isOrg) {
      return { status: 200, body: { data: { user: { projectV2: null } }, errors: [{ type: 'FORBIDDEN', path: ['user', 'projectV2'], message: 'Resource not accessible by integration' }] } };
    }
    return { status: 200, body: { data: { user: null }, errors: [{ type: 'NOT_FOUND', path: ['user'], message: `Could not resolve to a User with the login of '${login}'.` }] } };
  }
  const project = ctx.state.projects.find((p) => p.owner === login && p.number === number);
  if (!project) {
    return { status: 200, body: { data: { organization: { projectV2: null } }, errors: [{ type: 'NOT_FOUND', path: ['organization', 'projectV2'], message: `Could not resolve to a ProjectV2 with the number ${number}.` }] } };
  }
  const first = ctx.opts.pageSize ?? b.variables?.first ?? 100;
  const start = b.variables?.after ? Number(b.variables.after) : 0;
  const slice = project.items.slice(start, start + first);
  const end = start + slice.length;
  const nodes = slice.map((it) => ({
    content: { url: it.url },
    fieldValues: { nodes: Object.entries(it.fields).map(([k, v]) => fieldNode(k, v)) },
  }));
  return { status: 200, body: { data: { organization: { projectV2: {
    items: { nodes, pageInfo: { hasNextPage: end < project.items.length, endCursor: String(end) } },
  } } } } };
}
