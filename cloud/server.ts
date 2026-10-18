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
//   POST /account/delete        to GitHub to confirm; back at the callback, as the same GitHub account, the account and
//                               its sessions go, then its grant of the hosted app at GitHub, with that sign-in's token
//   GET  /api/account           the signed-in account as JSON, else 401
//   GET  /api/account/records   its hopper.io records as JSON, newest first, else 401
//   GET  /api/account/instances its registrations as JSON (issue #465), else 401
//   POST /account/instances/:id/name    names its own instance (`name`, empty clears it)
//   POST /account/instances/:id/remove  removes its own instance; its next hello is answered `unregister`
//   GET  /privacy               the privacy note (cloud/privacy.ts), signed in or not
import { randomBytes } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { hopperApps, type HopperApp } from '../src/connected-accounts/hopper-app.ts';
import { whoIs } from '../src/connected-accounts/identity.ts';
import { grantDeletion } from '../src/connected-accounts/revocation.ts';
import { webFlow } from '../src/connected-accounts/web-flow.ts';
import type { CloudConfig } from './config.ts';
import { INSTALL_ID } from './link.ts';
import { NEVER_KEPT, PRIVACY_NOTE } from './privacy.ts';
import { INSTANCE_NAME_MAX, SESSION_MS, SIGN_IN_MS, type CloudAccount, type CloudInstance, type CloudStore, type RecordKind } from './store.ts';

export const SESSION_COOKIE = 'hopper_io_session';
export const SIGN_IN_COOKIE = 'hopper_io_sign_in';
export const CALLBACK_PATH = '/auth/github/callback';
/** Where a person removes an app's grant at GitHub by hand, when hopper.io could not. */
export const GITHUB_AUTHORIZATIONS = 'https://github.com/settings/apps/authorizations';
const RECORD_LABELS: Record<RecordKind, string> = {
  signed_in: 'Signed in', signed_out: 'Signed out', deletion_refused: 'Deletion refused: confirmed as another GitHub account',
  instance_registered: 'Instance registered', instance_renamed: 'Instance named', instance_removed: 'Instance removed',
  instance_unlinked: 'Instance unlinked on the instance', instance_moved: 'Instance registered under another account',
};
const PRIVACY_LINK = '<p><a href="/privacy">What hopper.io keeps</a></p>';

/** An instance's name as its owner typed it: trimmed; '' clears it; undefined: refused (too long, a control character). */
export function instanceName(raw: string): string | undefined {
  const name = raw.trim();
  return [...name].length > INSTANCE_NAME_MAX || /\p{Cc}/u.test(name) ? undefined : name;
}

const instanceRow = (i: CloudInstance): string => `<li><strong>${i.name ? html(i.name) : 'No name'}</strong> (${i.installId}),`
  + ` registered ${i.registeredAt.toISOString()}, last seen ${i.seenAt ? i.seenAt.toISOString() : 'never'}`
  + `<form method="post" action="/account/instances/${i.installId}/name"><input name="name" maxlength="${INSTANCE_NAME_MAX}"`
  + ` value="${i.name ? html(i.name) : ''}" aria-label="Name"> <button type="submit">Name</button></form>`
  + `<form method="post" action="/account/instances/${i.installId}/remove"><button type="submit">Remove</button></form></li>`;

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
  const deleteGrant = grantDeletion(app, config.clientSecret);
  const secure = config.publicUrl.startsWith('https:') ? '; Secure' : '';
  const cookie = (name: string, value: string, path: string, maxAgeMs: number) =>
    `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${Math.floor(maxAgeMs / 1000)}; HttpOnly; SameSite=Lax${secure}`;
  // Behind a reverse proxy the address is the client's, from X-Forwarded-For, only when the runtime says so.
  const server = Fastify({ logger: false, trustProxy: config.trustProxy });
  await server.register(rateLimit, { global: false });
  // The forms post urlencoded; only an instance's name form has a field hopper.io reads (`name`).
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
    if (!a) return page(reply, 200, `<h1>hopper.io</h1><p><a href="/auth/github">Sign in with GitHub</a></p>${PRIVACY_LINK}`);
    const avatar = a.avatarUrl ? `<img src="${html(a.avatarUrl)}" alt="" width="40" height="40"> ` : '';
    const records = (await store.records(a.githubUserId, now())).map((r) => `<li>${r.at.toISOString()}: ${RECORD_LABELS[r.kind]}</li>`).join('');
    const instances = (await store.instances(a.githubUserId)).map(instanceRow).join('') || '<li>No instance is registered.</li>';
    return page(reply, 200, `<h1>hopper.io</h1><p>${avatar}Signed in as <strong>${html(a.login)}</strong>.</p>`
      + '<form method="post" action="/auth/sign-out"><button type="submit">Sign out</button></form>'
      + '<form method="post" action="/account/delete"><p>Delete your hopper.io account. You sign in with GitHub again to confirm.</p>'
      + `<button type="submit">Delete account</button></form><h2>Your instances</h2><ul>${instances}</ul><h2>What was done on your account</h2><ul>${records}</ul>${PRIVACY_LINK}`);
  });

  /** To GitHub, with the state also in this browser's cookie; `deletes`: the account the sign-in confirms the deletion of. */
  const toGitHub = async (reply: FastifyReply, deletes?: string) => {
    const state = randomBytes(32).toString('base64url');
    const { url, verifier } = await flow.start(state);
    await store.startSignIn(state, verifier, deletes);
    return reply.header('set-cookie', cookie(SIGN_IN_COOKIE, state, '/auth/github', SIGN_IN_MS)).redirect(url, 302);
  };

  server.get('/auth/github', { config: { rateLimit: SIGN_IN_LIMIT } }, (_req, reply) => toGitHub(reply));

  server.get(CALLBACK_PATH, { config: { rateLimit: SIGN_IN_LIMIT } }, async (req, reply) => {
    const callback = new URL(req.url, config.publicUrl);
    const state = callback.searchParams.get('state') ?? '';
    const mine = cookiesOf(req.headers.cookie).get(SIGN_IN_COOKIE);
    const clear = cookie(SIGN_IN_COOKIE, '', '/auth/github', 0);
    if (!state || state !== mine) return page(reply.header('set-cookie', clear), 400, '<p>This sign-in was not started in this browser. <a href="/auth/github">Sign in again</a>.</p>');
    const taken = await store.takeSignIn(state, now());
    if (!taken) return page(reply.header('set-cookie', clear), 400, '<p>This sign-in expired. <a href="/auth/github">Sign in again</a>.</p>');
    let account: CloudAccount;
    let accessToken: string;
    try {
      const grant = await flow.finish(callback, { verifier: taken.verifier, state });
      accessToken = grant.accessToken;
      const who = await whoIs(app, accessToken);
      account = { githubUserId: who.subject, login: who.account, ...(who.avatarUrl ? { avatarUrl: who.avatarUrl } : {}) };
    } catch {
      return page(reply.header('set-cookie', clear), 502, taken.deletes ? '<p>GitHub did not confirm it. Nothing was deleted. <a href="/">Back</a>.</p>'
        : '<p>GitHub did not complete the sign-in. <a href="/auth/github">Try again</a>.</p>');
    }
    if (taken.deletes) {
      if (account.githubUserId !== taken.deletes) {
        await store.record(taken.deletes, 'deletion_refused', now());
        return page(reply.header('set-cookie', clear), 403, '<p>You confirmed as another GitHub account. Nothing was deleted. <a href="/">Back</a>.</p>');
      }
      await store.deleteAccount(taken.deletes, now());
      const gone = await deleteGrant(accessToken).then(() => true, () => false);
      const grantNote = gone ? '<p>hopper.io no longer has your permission at GitHub.</p>'
        : `<p>GitHub did not remove hopper.io's permission. Remove it at <a href="${GITHUB_AUTHORIZATIONS}">${GITHUB_AUTHORIZATIONS}</a>.</p>`;
      return page(reply.header('set-cookie', [clear, cookie(SESSION_COOKIE, '', '/', 0)]), 200, `<p>Your hopper.io account is deleted.</p>${grantNote}`);
    }
    await store.signedIn(account);
    const token = randomBytes(32).toString('base64url');
    await store.openSession(token, account.githubUserId, now());
    await store.record(account.githubUserId, 'signed_in', now());
    return reply.header('set-cookie', [clear, cookie(SESSION_COOKIE, token, '/', SESSION_MS)]).redirect('/', 303);
  });

  server.post('/auth/sign-out', async (req, reply) => {
    if (req.headers.origin !== config.publicUrl) return reply.code(403).send({ error: 'sign out only from hopper.io itself' });
    const token = cookiesOf(req.headers.cookie).get(SESSION_COOKIE);
    const ended = token ? await store.endSession(token) : undefined;
    if (ended) await store.record(ended, 'signed_out', now());
    return reply.header('set-cookie', cookie(SESSION_COOKIE, '', '/', 0)).redirect('/', 303);
  });

  server.post('/account/delete', { config: { rateLimit: SIGN_IN_LIMIT } }, async (req, reply) => {
    if (req.headers.origin !== config.publicUrl) return reply.code(403).send({ error: 'delete only from hopper.io itself' });
    const a = await signedIn(req);
    if (!a) return reply.code(401).send({ error: 'not signed in' });
    return toGitHub(reply, a.githubUserId);
  });

  server.get('/api/account', async (req, reply) => {
    const a = await signedIn(req);
    if (!a) return reply.code(401).send({ error: 'not signed in' });
    return { githubUserId: a.githubUserId, login: a.login, ...(a.avatarUrl ? { avatarUrl: a.avatarUrl } : {}) };
  });

  server.get('/api/account/records', async (req, reply) => {
    const a = await signedIn(req);
    if (!a) return reply.code(401).send({ error: 'not signed in' });
    return { records: (await store.records(a.githubUserId, now())).map((r) => ({ kind: r.kind, at: r.at.toISOString() })) };
  });

  server.get('/api/account/instances', async (req, reply) => {
    const a = await signedIn(req);
    if (!a) return reply.code(401).send({ error: 'not signed in' });
    return { instances: (await store.instances(a.githubUserId)).map((i) => ({
      installId: i.installId, ...(i.name ? { name: i.name } : {}), registeredAt: i.registeredAt.toISOString(),
      ...(i.seenAt ? { seenAt: i.seenAt.toISOString() } : {}),
    })) };
  });

  /** The signed-in account and the instance id of a form post from hopper.io itself, else the reply already sent. */
  const ownInstance = async (req: FastifyRequest<{ Params: { installId: string } }>, reply: FastifyReply) => {
    if (req.headers.origin !== config.publicUrl) { await reply.code(403).send({ error: 'only from hopper.io itself' }); return undefined; }
    const a = await signedIn(req);
    if (!a) { await reply.code(401).send({ error: 'not signed in' }); return undefined; }
    if (!INSTALL_ID.test(req.params.installId)) { await reply.code(404).send({ error: 'no such instance' }); return undefined; }
    return { account: a.githubUserId, installId: req.params.installId };
  };

  server.post<{ Params: { installId: string } }>('/account/instances/:installId/name', async (req, reply) => {
    const own = await ownInstance(req, reply);
    if (!own) return reply;
    const name = instanceName(new URLSearchParams(typeof req.body === 'string' ? req.body : '').get('name') ?? '');
    if (name === undefined) return reply.code(400).send({ error: `a name of at most ${INSTANCE_NAME_MAX} characters, with no control character` });
    if (!await store.rename(own.account, own.installId, name || undefined)) return reply.code(404).send({ error: 'no such instance' });
    await store.record(own.account, 'instance_renamed', now());
    return reply.redirect('/', 303);
  });

  server.post<{ Params: { installId: string } }>('/account/instances/:installId/remove', async (req, reply) => {
    const own = await ownInstance(req, reply);
    if (!own) return reply;
    if (!await store.remove(own.account, own.installId, now())) return reply.code(404).send({ error: 'no such instance' });
    await store.record(own.account, 'instance_removed', now());
    return reply.redirect('/', 303);
  });

  server.get('/privacy', (_req, reply) => page(reply, 200, '<h1>What hopper.io keeps</h1>'
    + '<table><thead><tr><th>Field</th><th>What</th><th>Why</th><th>How long</th></tr></thead><tbody>'
    + PRIVACY_NOTE.map((f) => `<tr><td>${html(`${f.table}.${f.column}`)}</td><td>${html(f.what)}</td><td>${html(f.why)}</td><td>${html(f.kept)}</td></tr>`).join('')
    + `</tbody></table><h2>What hopper.io never keeps</h2><ul>${NEVER_KEPT.map((n) => `<li>${html(n)}</li>`).join('')}</ul>`));

  return server;
}

const html = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
