// A node:http fake GitHub API for tests of the connected account's adapter and everything built on it. It checks the
// credential the way GitHub does: the connected account's unexpired token (`token` or `Bearer`), which reaches the
// repositories the hopper's app is installed on. It answers at github.com's paths and at a GitHub Enterprise's. Bound to
// 127.0.0.1 only.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildState } from './fake-state.ts';
import type { FakeGitHubOptions, FakeRequestRecord, FakeState, FakeTokenRecord } from './fake-state.ts';
import { routeToken } from './fake-routes.ts';
import type { FakeCtx, FakeReply, FakeReq } from './fake-routes.ts';
import { graphql } from './fake-graphql.ts';

export type * from './fake-state.ts';

export interface FakeGitHubServer {
  /** e.g. http://127.0.0.1:41234 — the adapter's baseUrl. */
  url: string;
  state: FakeState;
  /** The next `times` requests matching "METHOD /path" (no query) answer `status`. */
  fail(route: string, status: number, message?: string, times?: number): void;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { return text; }
}

function send(res: ServerResponse, r: FakeReply): void {
  res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', ...r.headers });
  res.end(r.body === undefined ? '' : JSON.stringify(r.body));
}

export async function createFakeGitHubServer(o: FakeGitHubOptions): Promise<FakeGitHubServer> {
  const state = buildState(o, new Date().toISOString());
  const failures = new Map<string, { status: number; message: string; times: number }>();
  const ctx: FakeCtx = { state, opts: o, baseUrl: '', login: o.login ?? 'owner', now: () => new Date() };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const u = new URL(req.url ?? '/', ctx.baseUrl);
    // Served at a GitHub Enterprise's paths too (`/api/v3`, `/api/graphql`): a daemon whose HOPPER_GITHUB_URL names the fake.
    const path = u.pathname === '/api/graphql' ? '/graphql' : u.pathname.replace(/^\/api\/v3(?=\/)/, '');
    const r: FakeReq = { method: req.method ?? 'GET', path, query: Object.fromEntries(u.searchParams), body: await readBody(req) };
    const record: FakeRequestRecord = { method: r.method, path: r.path, query: r.query, auth: 'none', ...(r.body === undefined ? {} : { body: r.body }) };
    state.requests.push(record);

    const failure = failures.get(`${r.method} ${r.path}`);
    if (failure && failure.times > 0) {
      failure.times -= 1;
      return send(res, { status: failure.status, body: { message: failure.message } });
    }

    const m = /^(token|bearer)\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    const credential = m?.[2] ?? '';
    const token: FakeTokenRecord | undefined = state.tokens.find((t) => t.token === credential);
    if (!token || Date.parse(token.expiresAt) <= Date.now()) return send(res, { status: 401, body: { message: 'Bad credentials' } });
    record.auth = 'token';
    r.token = token;
    const reply = r.method === 'POST' && r.path === '/graphql' ? graphql(ctx, r) : routeToken(ctx, r);
    // A conditional request whose ETag still holds: 304, no body, as GitHub answers it (and does not charge it).
    if (reply.status === 200 && reply.headers?.etag !== undefined && req.headers['if-none-match'] === reply.headers.etag) {
      record.notModified = true;
      return send(res, { status: 304, headers: { etag: reply.headers.etag } });
    }
    return send(res, reply);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => send(res, { status: 500, body: { message: String(err) } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  ctx.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let closed: Promise<void> | undefined;
  return {
    url: ctx.baseUrl,
    state,
    fail(route, status, message = `fake failure ${status}`, times = Number.POSITIVE_INFINITY) {
      failures.set(route, { status, message, times });
    },
    close() {
      closed ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closed;
    },
  };
}
