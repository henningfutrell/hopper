// hopper.io's HTTP edge (issue #463, docs/cloud-hosting-identity.md): a person signs in with GitHub, through the
// hosted GitHub App's web flow (src/connected-accounts/web-flow.ts: authorization code with PKCE, openid-client), and
// gets a **hopper.io session**. GitHub's answer names the account (`whoIs`, `GET /user`): its numeric id is the key,
// its login and avatar URL are kept for display. The access token is dropped once `GET /user` answered: hopper.io
// keeps no GitHub token. A hopper.io session is no session of any instance, and no instance accepts it (decision 4).
//
//   GET  /                      the signed-in account, or the sign-in link
//   GET  /auth/github           to GitHub; the state also in a cookie of this browser, so only it can finish
//   GET  /auth/github/callback  back from GitHub: the account kept, the session opened
//   POST /auth/sign-out         ends this session only (decision 5); the account stays
//   GET  /api/account           the signed-in account as JSON, else 401
import { randomBytes } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { hopperApps, type HopperApp } from '../src/connected-accounts/hopper-app.ts';
import { whoIs } from '../src/connected-accounts/identity.ts';
import { webFlow } from '../src/connected-accounts/web-flow.ts';
import type { CloudConfig } from './config.ts';
import { SESSION_MS, SIGN_IN_MS, type CloudAccount, type CloudStore } from './store.ts';

export const SESSION_COOKIE = 'hopper_io_session';
export const SIGN_IN_COOKIE = 'hopper_io_sign_in';
export const CALLBACK_PATH = '/auth/github/callback';
/** Sign-ins per address (docs/hopper-io-security.md R7): a start and its callback each count. */
export const SIGN_IN_LIMIT = { max: 30, timeWindow: '1 minute' };

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; img-src https:; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

/** The hosted app: its client id, GitHub's origin and API. It has no slug to install: it is never installed on a repository. */
export function cloudApp(c: Pick<CloudConfig, 'githubUrl' | 'clientId'>): HopperApp {
  const { slug: _slug, ...app } = hopperApps({ github: { url: c.githubUrl, clientId: c.clientId } }).github;
  return app;
}

/** The cookies a request carries, by name. */
export function cookiesOf(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out.set(part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim()));
  }
  return out;
}

export async function cloudServer(o: { config: CloudConfig; store: CloudStore; now?: () => Date }): Promise<FastifyInstance> {
  const { config, store } = o;
  const now = o.now ?? (() => new Date());
  const app = cloudApp(config);
  const flow = webFlow(app, config.clientSecret, `${config.publicUrl}${CALLBACK_PATH}`);
  const secure = config.publicUrl.startsWith('https:') ? '; Secure' : '';
  const cookie = (name: string, value: string, path: string, maxAgeMs: number) =>
    `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; SameSite=Lax${secure}`;
  // Behind a reverse proxy the address is the client's, from X-Forwarded-For, only when the runtime says so.
  const server = Fastify({ logger: false, trustProxy: config.trustProxy });
  await server.register(rateLimit, { global: false });
  // The sign-out form posts urlencoded; it has no fields hopper.io reads.
  server.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  server.addHook('onSend', async (_req, reply) => { reply.headers(SECURITY_HEADERS); });

  const signedIn = (req: FastifyRequest): Promise<CloudAccount | undefined> => {
    const token = cookiesOf(req.headers.cookie).get(SESSION_COOKIE);
    return token ? store.sessionAccount(token, now()) : Promise.resolve(undefined);
  };
  const page = (reply: FastifyReply, status: number, body: string) =>
    reply.code(status).type('text/html; charset=utf-8').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>hopper.io</title></head><body>${body}</body></html>`);

  server.get('/', async (req, reply) => {
    const a = await signedIn(req);
    if (!a) return page(reply, 200, '<h1>hopper.io</h1><p><a href="/auth/github">Sign in with GitHub</a></p>');
    const avatar = a.avatarUrl ? `<img src="${html(a.avatarUrl)}" alt="" width="40" height="40"> ` : '';
    return page(reply, 200, `<h1>hopper.io</h1><p>${avatar}Signed in as <strong>${html(a.login)}</strong>.</p>`
      + '<form method="post" action="/auth/sign-out"><button type="submit">Sign out</button></form>');
  });

  server.get('/auth/github', { config: { rateLimit: SIGN_IN_LIMIT } }, async (_req, reply) => {
    const state = randomBytes(32).toString('base64url');
    const { url, verifier } = await flow.start(state);
    await store.startSignIn(state, verifier);
    return reply.header('set-cookie', cookie(SIGN_IN_COOKIE, state, '/auth/github', SIGN_IN_MS)).redirect(url, 302);
  });

  server.get(CALLBACK_PATH, { config: { rateLimit: SIGN_IN_LIMIT } }, async (req, reply) => {
    const callback = new URL(req.url, config.publicUrl);
    const state = callback.searchParams.get('state') ?? '';
    const mine = cookiesOf(req.headers.cookie).get(SIGN_IN_COOKIE);
    const clear = cookie(SIGN_IN_COOKIE, '', '/auth/github', 0);
    if (!state || state !== mine) return page(reply.header('set-cookie', clear), 400, '<p>This sign-in was not started in this browser. <a href="/auth/github">Sign in again</a>.</p>');
    const verifier = await store.takeSignIn(state, now());
    if (!verifier) return page(reply.header('set-cookie', clear), 400, '<p>This sign-in expired. <a href="/auth/github">Sign in again</a>.</p>');
    let account: CloudAccount;
    try {
      const grant = await flow.finish(callback, { verifier, state });
      const who = await whoIs(app, grant.accessToken);
      account = { githubUserId: who.subject, login: who.account, ...(who.avatarUrl ? { avatarUrl: who.avatarUrl } : {}) };
    } catch {
      return page(reply.header('set-cookie', clear), 502, '<p>GitHub did not complete the sign-in. <a href="/auth/github">Try again</a>.</p>');
    }
    await store.signedIn(account);
    const token = randomBytes(32).toString('base64url');
    await store.openSession(token, account.githubUserId, now());
    return reply.header('set-cookie', [clear, cookie(SESSION_COOKIE, token, '/', SESSION_MS)]).redirect('/', 303);
  });

  server.post('/auth/sign-out', async (req, reply) => {
    if (req.headers.origin !== config.publicUrl) return reply.code(403).send({ error: 'sign out only from hopper.io itself' });
    const token = cookiesOf(req.headers.cookie).get(SESSION_COOKIE);
    if (token) await store.endSession(token);
    return reply.header('set-cookie', cookie(SESSION_COOKIE, '', '/', 0)).redirect('/', 303);
  });

  server.get('/api/account', async (req, reply) => {
    const a = await signedIn(req);
    if (!a) return reply.code(401).send({ error: 'not signed in' });
    return { githubUserId: a.githubUserId, login: a.login, ...(a.avatarUrl ? { avatarUrl: a.avatarUrl } : {}) };
  });

  return server;
}

const html = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
