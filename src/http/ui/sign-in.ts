// The sign-in routes (design.md "Sign-in: realms"); the realms themselves are src/auth/. None of them needs a session, so all of them sit behind one per-address
// rate limit (@fastify/rate-limit, SIGN_IN_RATE a minute) in their own Fastify context. Routes:
//   POST /ui/login                        ← the one-time login code (a form)
//   POST /ui/auth/none                    → a no-sign-in session (exact UI Origin)
//   POST /ui/auth/password                ← { username, password }, tried against the password and LDAP
//                                           realms in order → a session (exact UI Origin)
//   GET  /ui/auth/<name>/start?binding=…  → 302 to the realm's identity provider
//   GET  /ui/auth/<name>/callback         ← OIDC and GitHub send the browser back here
//   POST /ui/auth/<name>/callback         ← SAML posts its response here (assertion consumer service)
//   POST /ui/auth/complete                ← the callback page: { ticket, binding } → { token, … }
//   GET  /ui/auth/<name>/metadata         → SAML service provider metadata
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LOCAL_IDENTITY, NO_SIGN_IN_IDENTITY, SignInRefused, type SignIn } from '../../auth/index.ts';
import type { Clock, InstanceStore } from '../../domain/ports.ts';
import type { Identity, UiRole, User } from '../../domain/types.ts';
import { parseWith } from '../errors.ts';
import { FAVICON_LINK } from '../static.ts';
import { useLoginCode } from './login-code.ts';
import { sessionUser, type UiSessions } from './sessions.ts';

/** Sign-in attempts a minute from one address, every sign-in route together. */
export const SIGN_IN_RATE = 20;

const nameParams = z.object({ name: z.string() });
export const startQuery = z.object({ binding: z.string().optional() });
export const completeBody = z.object({ ticket: z.string(), binding: z.string() });
export const loginBody = z.object({ code: z.string() });
export const passwordBody = z.object({ username: z.string().max(128), password: z.string().max(1024) });

/** The login answer: store the token (hex, safe inline) for this exact origin, then go to the UI. */
const loginPage = (token: string): string => `<!doctype html><meta charset="utf-8"><title>hopper</title>${FAVICON_LINK}
<script>try { localStorage.setItem('jh_session', '${token}'); } catch (e) {} location.replace('/');</script>
<noscript>JavaScript is needed to keep the UI session.</noscript>
`;

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A plain page saying what happened, with the way back. */
const page = (title: string, text: string): string => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>hopper — ${esc(title)}</title>${FAVICON_LINK}<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem">
<h1 style="font-size:1.2rem">${esc(title)}</h1><p>${esc(text)}</p><p><a href="/">Back to hopper</a></p>`;

/**
 * The callback's answer: post the ticket with this browser's binding (kept in localStorage when the
 * sign-in began), store the session token, go to the UI. Ticket is hex: safe inline.
 */
const ticketPage = (ticket: string): string => `<!doctype html><meta charset="utf-8"><title>hopper — signing in</title>${FAVICON_LINK}
<body style="font-family:system-ui,sans-serif"><p id="m">Signing in…</p><script>
(async () => {
  let binding = null;
  try { binding = localStorage.getItem('jh_sign_in'); localStorage.removeItem('jh_sign_in'); } catch (e) {}
  const res = await fetch('/ui/auth/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: '${ticket}', binding: binding || '' }) });
  const out = await res.json().catch(() => ({}));
  if (res.ok) { try { localStorage.setItem('jh_session', out.token); } catch (e) {} location.replace('/'); return; }
  document.getElementById('m').textContent = (out.error || 'Sign-in failed') + '. Start again from the hopper page in this browser.';
})();
</script><noscript>JavaScript is needed to keep the UI session.</noscript>`;

const html = (reply: FastifyReply, status: number, body: string) =>
  reply.code(status).type('text/html; charset=utf-8').header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').send(body);

export function registerSignInRoutes(parent: FastifyInstance, o: {
  sessions: UiSessions; signIn: SignIn; instance: Pick<InstanceStore, 'loginCodes'>; clock: Clock;
  /** The user an identity signs in as (issue #158): linked, owner for no sign-in, or a new one. */
  userFor: (who: Identity) => Promise<User>;
  /** A user's name by id (a login code names its user by id). */
  userName: (id: string) => string;
  /** An origin UI mutations come from (loopback, a LAN name, the public URL): no sign-in and password sign-in answer there. */
  isUiOrigin: (origin: string) => boolean;
  refuse: (req: FastifyRequest, reply: FastifyReply, why: string, needs?: UiRole) => unknown;
}): void {
  parent.register(async (app) => {
    await app.register(rateLimit, { max: SIGN_IN_RATE, timeWindow: '1 minute' });
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });
    routes(app, o);
  });
}

function routes(app: FastifyInstance, o: Parameters<typeof registerSignInRoutes>[1]): void {
  const { signIn, sessions } = o;

  /** A session for `who`, as its user, answered as JSON: the UI stores the token. */
  const started = async (reply: FastifyReply, who: Identity, role: UiRole) => {
    const user = await o.userFor(who);
    const s = sessions.create({ role, identity: who, userId: user.id });
    const shown = sessionUser(s, user.name);
    console.warn(`hopper: UI session started: ${who.realm} ${shown.identity} as user ${user.id}, role ${role}`);
    return reply.header('cache-control', 'no-store').send({ token: s.token, expiresAt: s.expiresAt, user: shown });
  };
  const fromSignInOrigin = (req: FastifyRequest): boolean => req.headers.origin?.toLowerCase() === signIn.origin();
  // Nothing comes back from an identity provider, so these answer on any UI origin, not only the sign-in origin.
  const fromUiOrigin = (req: FastifyRequest): boolean => { const x = req.headers.origin?.toLowerCase(); return x !== undefined && o.isUiOrigin(x); };

  // Origin may be null (a local file posts it); the code is the credential.
  app.post('/ui/login', async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!signIn.local) return o.refuse(req, reply, 'local sign-in is off in auth.yaml');
    const userId = parsed.success ? useLoginCode(o.instance, o.clock, parsed.data.code) : undefined;
    if (userId === undefined) return o.refuse(req, reply, 'wrong, used, expired or missing login code');
    const s = sessions.create({ role: 'admin', identity: LOCAL_IDENTITY, userId });
    console.warn(`hopper: UI session started: local login code as user ${userId} (${o.userName(userId)}), role admin`);
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
      .send(loginPage(s.token));
  });

  // No credential: the exact Origin keeps another site from minting sessions in a visitor's browser.
  app.post('/ui/auth/none', async (req, reply) => {
    if (signIn.none === null) return o.refuse(req, reply, 'no sign-in is off in auth.yaml');
    if (!fromUiOrigin(req)) return o.refuse(req, reply, `origin ${req.headers.origin ?? '(none)'} not allowed`);
    return started(reply, NO_SIGN_IN_IDENTITY, signIn.none);
  });

  app.post('/ui/auth/password', async (req, reply) => {
    if (!signIn.password) return o.refuse(req, reply, 'password sign-in is off: no password or LDAP realm is on in auth.yaml');
    if (!fromUiOrigin(req)) return o.refuse(req, reply, `origin ${req.headers.origin ?? '(none)'} not allowed`);
    const { username, password } = parseWith(passwordBody, req.body);
    const r = await signIn.checkPassword(username, password);
    if (!r.ok) {
      const who = r.who ? ` (${r.who.realm} ${r.who.subject})` : '';
      if (r.status === 403) return o.refuse(req, reply, `${r.error}${who}`);
      console.warn(`hopper: password sign-in failed: ${r.error}`);
      return reply.code(r.status).send({ error: r.error });
    }
    return started(reply, r.who, r.role);
  });

  app.get('/ui/auth/:name/start', async (req, reply) => {
    const { name } = parseWith(nameParams, req.params);
    // The binding lives in this origin's localStorage; the identity provider returns to the sign-in origin.
    if (req.headers.host?.toLowerCase() !== new URL(signIn.origin()).host) {
      return html(reply, 409, page('Sign in on the sign-in address', `Open ${signIn.origin()} and sign in there.`));
    }
    try {
      return reply.header('cache-control', 'no-store').redirect(await signIn.begin(name, parseWith(startQuery, req.query).binding ?? ''), 302);
    } catch (e) {
      if (e instanceof SignInRefused) return html(reply, e.status, page('Cannot sign in', e.message));
      console.warn(`hopper: sign-in with ${name} could not start: ${(e as Error).message}`);
      return html(reply, 502, page('Cannot sign in', (e as Error).message));
    }
  });

  const callback = async (req: FastifyRequest, reply: FastifyReply) => {
    const { name } = parseWith(nameParams, req.params);
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, string> : undefined;
    const r = await signIn.callback(name, { url: new URL(req.url, signIn.origin()), ...(body ? { body } : {}) });
    if (!r.ok) {
      const who = r.who ? ` (${r.who.realm} ${r.who.email ?? r.who.username ?? r.who.subject})` : '';
      console.warn(`hopper: sign-in with ${name} refused${who}: ${r.error}`);
      return html(reply, r.status, page('Not signed in', r.error));
    }
    return html(reply, 200, ticketPage(r.ticket));
  };
  app.get('/ui/auth/:name/callback', callback);
  app.post('/ui/auth/:name/callback', callback);

  app.post('/ui/auth/complete', async (req, reply) => {
    if (!fromSignInOrigin(req)) return o.refuse(req, reply, `origin ${req.headers.origin ?? '(none)'} not allowed`);
    const { ticket, binding } = parseWith(completeBody, req.body);
    const r = signIn.complete(ticket, binding);
    if (!r) return o.refuse(req, reply, 'unknown, used or expired sign-in, or another browser began it');
    return started(reply, r.who, r.role);
  });

  app.get('/ui/auth/:name/metadata', async (req, reply) => {
    const p = signIn.redirectRealm(parseWith(nameParams, req.params).name);
    if (!p?.metadata) return reply.code(404).send({ error: 'no SAML realm by that name is on' });
    return reply.type('application/samlmetadata+xml; charset=utf-8').send(p.metadata());
  });
}
