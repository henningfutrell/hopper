// REST endpoints of the fake GitHub: app installations, token minting, installation repos,
// issues, comments, labels. Response shapes follow the GitHub REST API (the fields the adapter
// reads). Authentication is checked by fake-server.ts before a route runs.

import { randomBytes } from 'node:crypto';
import type { FakeGitHubOptions, FakeIssue, FakeRepo, FakeState, FakeTokenRecord } from './fake-state.ts';

export interface FakeReply { status: number; body?: unknown; headers?: Record<string, string> }
export interface FakeCtx { state: FakeState; opts: FakeGitHubOptions; baseUrl: string; bot: string; now(): Date }
export interface FakeReq { method: string; path: string; query: Record<string, string>; body: unknown; token?: FakeTokenRecord }

const notFound: FakeReply = { status: 404, body: { message: 'Not Found' } };

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
    user: { login: i.author }, labels: i.labels.map((name) => ({ name })),
    closed_by: i.closedBy ? { login: i.closedBy } : null, ...(i.pullRequest ? { pull_request: {} } : {}),
  };
}

function restComment(r: FakeRepo, n: number, c: { id: number; author: string; body: string; createdAt: string }) {
  return { id: c.id, body: c.body, user: { login: c.author }, created_at: c.createdAt, html_url: `${issueUrl(r, n)}#issuecomment-${c.id}` };
}

/** Repos a token may reach: its installation's, narrowed by the minted `repositories`. */
export function tokenReaches(t: FakeTokenRecord, repo: FakeRepo): boolean {
  return repo.installationId === t.installationId && (t.body.repositories === undefined || t.body.repositories.includes(repo.name));
}

function appRoutes(ctx: FakeCtx, req: FakeReq): FakeReply | undefined {
  const { state } = ctx;
  if (req.method === 'GET' && req.path === '/app/installations') {
    const all = state.installations.map((i) => ({ id: i.id, account: { login: i.account, type: i.accountType ?? 'User' } }));
    const p = paginate(ctx, req, all);
    return { status: 200, body: p.items, headers: p.headers };
  }
  const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(req.path);
  if (req.method === 'POST' && mint) {
    const inst = state.installations.find((i) => i.id === Number(mint[1]));
    if (!inst) return notFound;
    const body = (req.body ?? {}) as FakeTokenRecord['body'];
    const names = inst.repos.map((r) => r.name);
    if (body.repositories?.some((n) => !names.includes(n))) return { status: 422, body: { message: 'There is at least one repository that does not exist or is not accessible to the parent installation.' } };
    const record: FakeTokenRecord = {
      token: `ghs_${randomBytes(16).toString('hex')}`, installationId: inst.id, body,
      expiresAt: new Date(ctx.now().getTime() + 3600_000).toISOString(),
    };
    state.tokens.push(record);
    return { status: 201, body: {
      token: record.token, expires_at: record.expiresAt, permissions: body.permissions ?? { issues: 'write', metadata: 'read' },
      repository_selection: body.repositories ? 'selected' : 'all',
      ...(body.repositories ? { repositories: body.repositories.map((name, id) => ({ id: id + 1, name })) } : {}),
    } };
  }
  const lookup = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(req.path);
  if (req.method === 'GET' && lookup) {
    const repo = state.repos.get(`${lookup[1]}/${lookup[2]}`);
    return repo ? { status: 200, body: { id: repo.installationId } } : notFound;
  }
  return undefined;
}

function installationRepos(ctx: FakeCtx, req: FakeReq): FakeReply {
  const t = req.token!;
  const repos = [...ctx.state.repos.values()].filter((r) => tokenReaches(t, r));
  const p = paginate(ctx, req, repos.map((r) => ({ name: r.name, full_name: `${r.owner}/${r.name}`, owner: { login: r.owner } })));
  return { status: 200, body: { total_count: repos.length, repositories: p.items }, headers: p.headers };
}

function issueRoutes(ctx: FakeCtx, req: FakeReq, repo: FakeRepo, rest: string): FakeReply | undefined {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (req.method === 'GET' && rest === '/issues') {
    const state = req.query.state ?? 'open';
    const want = (req.query.labels ?? '').split(',').filter(Boolean);
    const list = [...repo.issues.values()].sort((a, b) => a.number - b.number)
      .filter((i) => (state === 'all' || i.state === state) && want.every((l) => i.labels.includes(l)));
    const p = paginate(ctx, req, list.map((i) => restIssue(repo, i)));
    return { status: 200, body: p.items, headers: p.headers };
  }
  const editComment = /^\/issues\/comments\/(\d+)$/.exec(rest);
  if (req.method === 'PATCH' && editComment) {
    for (const i of repo.issues.values()) {
      const c = i.comments.find((x) => x.id === Number(editComment[1]));
      if (!c) continue;
      if (c.author !== ctx.bot) return { status: 403, body: { message: 'Resource not accessible by integration' } };
      c.body = String(body.body ?? '');
      return { status: 200, body: restComment(repo, i.number, c) };
    }
    return notFound;
  }
  if (req.method === 'POST' && rest === '/labels') {
    const name = String(body.name ?? '');
    if (repo.labels.has(name)) return { status: 422, body: { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }] } };
    repo.labels.add(name);
    return { status: 201, body: { name, color: body.color, description: body.description } };
  }
  const m = /^\/issues\/(\d+)(\/comments|\/labels(?:\/(.+))?)?$/.exec(rest);
  const issue = m ? repo.issues.get(Number(m[1])) : undefined;
  if (!m || !issue) return notFound;
  const sub = m[2] ?? '';
  if (req.method === 'GET' && sub === '') return { status: 200, body: restIssue(repo, issue) };
  if (req.method === 'GET' && sub === '/comments') {
    const p = paginate(ctx, req, issue.comments.map((c) => restComment(repo, issue.number, c)));
    return { status: 200, body: p.items, headers: p.headers };
  }
  if (req.method === 'POST' && sub === '/comments') {
    const c = { id: ctx.state.nextCommentId++, author: ctx.bot, body: String(body.body ?? ''), createdAt: ctx.now().toISOString() };
    issue.comments.push(c);
    return { status: 201, body: restComment(repo, issue.number, c) };
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

/** Routes for a JWT-authenticated request (`/app/*`, repo installation lookup). */
export function routeJwt(ctx: FakeCtx, req: FakeReq): FakeReply {
  return appRoutes(ctx, req) ?? notFound;
}

/** Routes for an installation-token request. */
export function routeToken(ctx: FakeCtx, req: FakeReq): FakeReply {
  if (req.method === 'GET' && req.path === '/installation/repositories') return installationRepos(ctx, req);
  const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)$/.exec(req.path);
  const repo = m ? ctx.state.repos.get(`${m[1]}/${m[2]}`) : undefined;
  if (!m || !repo || !tokenReaches(req.token!, repo)) return notFound;
  return issueRoutes(ctx, req, repo, m[3]!) ?? notFound;
}
