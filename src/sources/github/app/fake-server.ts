// A node:http fake GitHub API for tests of the App adapter and everything built on it. It checks
// credentials the way GitHub does: a JWT (RS256, signed by the app key, iss = appId, exp at most
// 10 min ahead) on `/app/*` and `/repos/{o}/{r}/installation`; an unexpired installation token
// (`token` or `Bearer`) with the right repo scope everywhere else. Bound to 127.0.0.1 only.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verify } from 'node:crypto';
import { buildState } from './fake-state.ts';
import type { FakeGitHubOptions, FakeState, FakeTokenRecord } from './fake-state.ts';
import { routeJwt, routeToken } from './fake-routes.ts';
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

const JWT_PATH = /^\/app\/|^\/repos\/[^/]+\/[^/]+\/installation$/;

function b64json(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** RS256 signature by `publicKeyPem`, iss = appId, iat not in the future, exp in (now, now+600]. */
export function verifyAppJwt(jwt: string, publicKeyPem: string, appId: number, nowSec: number): boolean {
  try {
    const [h, p, s] = jwt.split('.');
    if (!h || !p || !s) return false;
    if (b64json(h).alg !== 'RS256') return false;
    if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKeyPem, Buffer.from(s, 'base64url'))) return false;
    const claims = b64json(p);
    const exp = Number(claims.exp);
    const iat = Number(claims.iat);
    return String(claims.iss) === String(appId) && exp > nowSec && exp <= nowSec + 600 && iat <= nowSec + 60;
  } catch {
    return false;
  }
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
  const ctx: FakeCtx = { state, opts: o, baseUrl: '', bot: `${o.slug ?? 'hopper'}[bot]`, now: () => new Date() };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const u = new URL(req.url ?? '/', ctx.baseUrl);
    const r: FakeReq = { method: req.method ?? 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), body: await readBody(req) };
    const record = { method: r.method, path: r.path, query: r.query, auth: 'none' as 'jwt' | 'token' | 'none', ...(r.body === undefined ? {} : { body: r.body }) };
    state.requests.push(record);

    const failure = failures.get(`${r.method} ${r.path}`);
    if (failure && failure.times > 0) {
      failure.times -= 1;
      return send(res, { status: failure.status, body: { message: failure.message } });
    }

    const m = /^(token|bearer)\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    const credential = m?.[2] ?? '';
    const nowSec = Math.floor(Date.now() / 1000);
    if (JWT_PATH.test(r.path)) {
      if (!verifyAppJwt(credential, o.publicKeyPem, o.appId, nowSec)) {
        return send(res, { status: 401, body: { message: 'A JSON web token could not be decoded' } });
      }
      record.auth = 'jwt';
      return send(res, routeJwt(ctx, r));
    }
    const token: FakeTokenRecord | undefined = state.tokens.find((t) => t.token === credential);
    if (!token || Date.parse(token.expiresAt) <= Date.now()) return send(res, { status: 401, body: { message: 'Bad credentials' } });
    record.auth = 'token';
    r.token = token;
    return send(res, r.method === 'POST' && r.path === '/graphql' ? graphql(ctx, r) : routeToken(ctx, r));
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
