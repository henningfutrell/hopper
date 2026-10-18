// REST endpoints of the fake GitHub, as a connected account's token reaches them:
// issues (read; a repository's issue list with `since`, newest change first, and an ETag), comments, assignment events, assignees, labels, a pull request's merge. Response shapes follow the GitHub REST API (the fields the adapter
// reads). Authentication is checked by fake-server.ts before a route runs.

import { createHash } from 'node:crypto';
import type { FakeGitHubOptions, FakeIssue, FakeRepo, FakeState, FakeTokenRecord } from './fake-state.ts';
import { endPull } from './fake-pull-end.ts';

export interface FakeReply { status: number; body?: unknown; headers?: Record<string, string> }
export interface FakeCtx { state: FakeState; opts: FakeGitHubOptions; baseUrl: string; login: string; now(): Date }
export interface FakeReq { method: string; path: string; query: Record<string, string>; body: unknown; token?: FakeTokenRecord }

const notFound: FakeReply = { status: 404, body: { message: 'Not Found' } };

/** An answer's ETag: the same body, the same tag. */
export const etagOf = (body: unknown): string => `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;

/** One page of `items` plus a Link header when more follow. */
export function paginate<T>(ctx: FakeCtx, req: FakeReq, items: T[]): { items: T[]; headers: Record<string, string> } {
  const per = ctx.opts.pageSize ?? Math.min(100, Number(req.query.per_page ?? '30') || 30);
  const page = Math.max(1, Number(req.query.page ?? '1') || 1);
  const slice = items.slice((page - 1) * per, page * per);
  if (page * per >= items.length) return { items: slice, headers: {} };
  const next = new URLSearchParams({ ...req.query, page: String(page + 1) });
  return { items: slice, headers: { link: `<${ctx.baseUrl}${req.path}?${next.toString()}>; rel="next"` } };
}

const issueUrl = (r: FakeRepo, n: number) => `https://github.com/${r.owner}/${r.name}/issues/${n}`;

function restIssue(r: FakeRepo, i: FakeIssue) {
  return {
    number: i.number, title: i.title, body: i.body, state: i.state, html_url: issueUrl(r, i.number), updated_at: i.updatedAt,
    user: { login: i.author }, assignees: i.assignees.map((login) => ({ login })), labels: i.labels.map((name) => ({ name })),
    closed_by: i.closedBy ? { login: i.closedBy } : null, closed_at: i.closedAt ?? null, state_reason: i.stateReason ?? null, ...(i.pullRequest ? { pull_request: {} } : {}),
  };
}

function restComment(r: FakeRepo, n: number, c: { id: number; author: string; body: string; createdAt: string }) {
  return { id: c.id, body: c.body, user: { login: c.author }, created_at: c.createdAt, html_url: `${issueUrl(r, n)}#issuecomment-${c.id}` };
}

/**
 * A commit's check runs or combined status (issue #1244), of the pull request entry whose head is `ref` (its head commit or
 * branch); 403 when the token lacks the permission.
 */
function commitChecks(repo: FakeRepo, ref: string, what: 'checks' | 'statuses'): FakeReply {
  if (repo.lacks.includes(what)) return { status: 403, body: { message: 'Resource not accessible by integration' } };
  const pull = [...repo.issues.values()].find((i) => i.pullRequest && ((i.pull?.headOid ?? `h${i.number}`) === ref || (i.pull?.headRef ?? `issue-${i.number}`) === ref))?.pull;
  if (what === 'checks') return { status: 200, body: { total_count: pull?.checkRuns?.length ?? 0, check_runs: pull?.checkRuns ?? [] } };
  const statuses = pull?.statuses ?? [];
  return { status: 200, body: { state: statuses.length ? statuses[0]!.state : 'pending', total_count: statuses.length, statuses } };
}

function issueRoutes(ctx: FakeCtx, req: FakeReq, repo: FakeRepo, rest: string): FakeReply | undefined {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (req.method === 'GET' && rest === '/issues') {
    const state = req.query.state ?? 'open';
    const want = (req.query.labels ?? '').split(',').filter(Boolean);
    const since = req.query.since;
    const byUpdate = req.query.sort === 'updated';
    const list = [...repo.issues.values()].sort((a, b) => (byUpdate ? b.updatedAt.localeCompare(a.updatedAt) : a.number - b.number))
      .filter((i) => (state === 'all' || i.state === state) && want.every((l) => i.labels.includes(l)) && (since === undefined || i.updatedAt >= since));
    const p = paginate(ctx, req, list.map((i) => restIssue(repo, i)));
    // A list read is conditional, as on GitHub (issue #1125): its ETag, and a 304 for a request that names it (fake-server.ts).
    return { status: 200, body: p.items, headers: { ...p.headers, etag: etagOf(p.items) } };
  }
  if (req.method === 'POST' && rest === '/labels') {
    const name = String(body.name ?? '');
    if (repo.labels.has(name)) return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] } };
    repo.labels.add(name);
    return { status: 201, body: { name, color: body.color, description: body.description } };
  }
  // The hopper's merge (issue #985 part 4): a pull request not open cannot be merged.
  const merge = /^\/pulls\/(\d+)\/merge$/.exec(rest);
  if (req.method === 'PUT' && merge) {
    if (!endPull(repo, Number(merge[1]), 'MERGED', ctx.now().toISOString())) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    return { status: 200, body: { merged: true, message: 'Pull Request successfully merged' } };
  }
  const commit = /^\/commits\/([^/]+)\/(check-runs|status)$/.exec(rest);
  if (req.method === 'GET' && commit) return commitChecks(repo, decodeURIComponent(commit[1]!), commit[2] === 'check-runs' ? 'checks' : 'statuses');
  const m = /^\/issues\/(\d+)(\/comments|\/events|\/assignees|\/labels(?:\/(.+))?)?$/.exec(rest);
  const issue = m ? repo.issues.get(Number(m[1])) : undefined;
  if (!m || !issue) return notFound;
  const sub = m[2] ?? '';
  if (req.method === 'GET' && sub === '') return { status: 200, body: restIssue(repo, issue) };
  // A close (issue #1959: Decline's close as not planned); a second close of a closed issue changes nothing, as on GitHub.
  if (req.method === 'PATCH' && sub === '' && body.state === 'closed') {
    if (issue.state !== 'closed') {
      const now = ctx.now().toISOString();
      Object.assign(issue, { state: 'closed', closedBy: ctx.login, closedAt: now, updatedAt: now, ...(typeof body.state_reason === 'string' ? { stateReason: body.state_reason } : {}) });
    }
    return { status: 200, body: restIssue(repo, issue) };
  }
  if (req.method === 'GET' && sub === '/comments') {
    const p = paginate(ctx, req, issue.comments.map((c) => restComment(repo, issue.number, c)));
    return { status: 200, body: p.items, headers: p.headers };
  }
  if (req.method === 'POST' && sub === '/comments') {
    const c = { id: ctx.state.nextCommentId++, author: ctx.login, body: String(body.body ?? ''), createdAt: ctx.now().toISOString() };
    issue.comments.push(c);
    return { status: 201, body: restComment(repo, issue.number, c) };
  }
  if (req.method === 'GET' && sub === '/events') {
    // Its labels and assignments, each by its author (issue #652: who added them is what intake trusts).
    const actor = { login: issue.author, type: 'User' };
    const p = paginate(ctx, req, [
      ...issue.labels.map((name) => ({ event: 'labeled', created_at: issue.updatedAt, actor, label: { name } })),
      ...issue.assignees.map((login) => ({ event: 'assigned', created_at: issue.updatedAt, actor, assignee: { login } })),
    ]);
    return { status: 200, body: p.items, headers: p.headers };
  }
  if (req.method === 'POST' && sub === '/assignees') {
    for (const login of (body.assignees as string[] | undefined) ?? []) if (!issue.assignees.includes(login)) issue.assignees.push(login);
    issue.updatedAt = ctx.now().toISOString();
    return { status: 201, body: restIssue(repo, issue) };
  }
  if (req.method === 'POST' && sub === '/labels') {
    for (const l of (body.labels as string[] | undefined) ?? []) {
      repo.labels.add(l);
      if (!issue.labels.includes(l)) issue.labels.push(l);
    }
    return { status: 200, body: issue.labels.map((name) => ({ name })) };
  }
  if (req.method === 'DELETE' && m[3] !== undefined) {
    const name = decodeURIComponent(m[3]);
    if (!issue.labels.includes(name)) return { status: 404, body: { message: 'Label does not exist' } };
    issue.labels = issue.labels.filter((l) => l !== name);
    return { status: 200, body: issue.labels.map((n) => ({ name: n })) };
  }
  return undefined;
}

/** Routes for a request with the connected account's token: the repositories the hopper's app is installed on. */
export function routeToken(ctx: FakeCtx, req: FakeReq): FakeReply {
  const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)$/.exec(req.path);
  const repo = m ? ctx.state.repos.get(`${m[1]}/${m[2]}`) : undefined;
  if (!m || !repo) return notFound;
  return issueRoutes(ctx, req, repo, m[3]!) ?? notFound;
}
