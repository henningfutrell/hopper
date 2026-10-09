// POST /graphql of the fake GitHub: `organization(login).projectV2(number)` and
// `user(login).projectV2(number)` items, behaving as GitHub does for an installation token:
// organization projects are readable; a user-owned project is FORBIDDEN ("Resource not
// accessible by integration"); a login of the other kind is NOT_FOUND. Also
// `repository(owner, name).issue(number)`: the pull request whose merge closed the issue, and the
// open ones whose merge will close it.

import { tokenReaches } from './fake-routes.ts';
import type { FakeCtx, FakeReply, FakeReq } from './fake-routes.ts';

interface GqlBody {
  query?: string;
  variables?: { login?: string; owner?: string; name?: string; number?: number; first?: number; after?: string | null };
}

/** `repository(owner, name).issue(number)` last ClosedEvent: its closer, a pull request or none. */
function closer(ctx: FakeCtx, req: FakeReq, b: GqlBody): FakeReply {
  const repo = ctx.state.repos.get(`${b.variables?.owner}/${b.variables?.name}`);
  if (!repo || !tokenReaches(req.token!, repo)) {
    return { status: 200, body: { data: { repository: null }, errors: [{ type: 'NOT_FOUND', path: ['repository'], message: 'Could not resolve to a Repository.' }] } };
  }
  const issue = repo.issues.get(Number(b.variables?.number));
  if (!issue) return { status: 200, body: { data: { repository: { issue: null } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'issue'], message: 'Could not resolve to an Issue.' }] } };
  if (/CROSS_REFERENCED_EVENT/.test(b.query ?? '')) {
    const nodes = issue.mentionedBy.map(({ repo: nameWithOwner, ...m }) => ({ source: { __typename: 'PullRequest', ...m, repository: { nameWithOwner } } }));
    return { status: 200, body: { data: { repository: { issue: { timelineItems: { nodes } } } } } };
  }
  if (/closedByPullRequestsReferences/.test(b.query ?? '')) {
    const open = issue.openPullRequests.map((p) => ({ ...p, state: 'OPEN' }));
    return { status: 200, body: { data: { repository: { issue: { closedByPullRequestsReferences: { nodes: open } } } } } };
  }
  const pr = issue.closedByPullRequest;
  const nodes = issue.state !== 'closed' ? [] : [{ closer: pr ? { __typename: 'PullRequest', ...pr } : null }];
  return { status: 200, body: { data: { repository: { issue: { timelineItems: { nodes } } } } } };
}

function fieldNode(name: string, value: string | number) {
  return typeof value === 'number' ? { number: value, field: { name } } : { name: value, field: { name } };
}

export function graphql(ctx: FakeCtx, req: FakeReq): FakeReply {
  const b = (req.body ?? {}) as GqlBody;
  const query = b.query ?? '';
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
