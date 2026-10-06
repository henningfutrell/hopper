// The sign-in routes (design.md "Sign-in: realms"); the realms themselves are src/auth/. None of them needs a session, so all of them sit behind one per-address
// rate limit (@fastify/rate-limit, SIGN_IN_RATE a minute) in their own Fastify context. Routes:
//   POST /ui/login                        ← the one-time login code (a form)
//   POST /ui/auth/none                    → a no-sign-in session (exact UI Origin)
//   POST /ui/auth/password                ← { username, password }, tried against the LDAP
//                                           realms in order → a session (exact UI Origin)
//   POST /ui/auth/gateway                 ← the token an auth gateway forwards, checked by the gateway
//                                           realms in order → a session (exact UI Origin)
//   POST /ui/auth/<name>/device           ← { binding }: a GitHub realm's device code (issue #214)
//   POST /ui/auth/device/poll             ← { flow, binding }: waiting, failed, or the session — and the
//                                           token the provider granted becomes the user's connection
//   GET  /ui/auth/<name>/start?binding=…  → 302 to the realm's identity provider
//   GET  /ui/auth/<name>/callback         ← OIDC, or GitHub by redirect (issue #258), sends the browser back here
//   POST /ui/auth/<name>/callback         ← SAML posts its response here (assertion consumer service)
//   POST /ui/auth/complete                ← the callback page: { ticket, binding } → { token, … } (and a
//                                           GitHub sign-in's token becomes the user's connection)
//   GET  /ui/auth/<name>/metadata         → SAML service provider metadata
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LOCAL_IDENTITY, NO_SIGN_IN_IDENTITY, SignInRefused, type SignIn } from '../../auth/index.ts';
import type { Clock, Connection, InstanceStore } from '../../domain/ports.ts';
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
export const deviceStartBody = z.object({ binding: z.string().max(128) });
export const devicePollBody = z.object({ flow: z.string().max(128), binding: z.string().max(128) });

/** The login answer: store the token (hex, safe inline) for this exact origin, then go to the UI. */
const loginPage = (token: string): string => `<!doctype html><meta charset="utf-8"><title>hopper</title>${FAVICON_LINK}
<script>try { localStorage.setItem('jh_session', '${token}'); } catch (e) {} location.replace('/');</script>
<noscript>JavaScript is needed to keep the UI session.</noscript>
`;

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The look of the landing page (issue #258) for the few pages the daemon writes itself: one card on the night backdrop. */
const LOOK = `<style>
html{color-scheme:dark}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:1rem;box-sizing:border-box;font:14px/1.5 system-ui,sans-serif;color:#f4f4f5;
background:radial-gradient(60vmax 60vmax at 15% 10%,#1ecad433,transparent 60%),radial-gradient(60vmax 60vmax at 90% 20%,#3b4fd633,transparent 60%),linear-gradient(180deg,#0b1220,#070b14)}
main{width:100%;max-width:24rem;text-align:center;padding:2rem 1.75rem;border:1px solid #ffffff1a;border-radius:1rem;background:#16161ab3;box-shadow:0 25px 50px -12px #0009}
h1{font-size:1.1rem;font-weight:600;margin:0 0 .5rem}p{margin:.5rem 0;color:#a1a1aa}a{color:#f4f4f5}
.spin{width:1.25rem;height:1.25rem;margin:0 auto .75rem;border:2px solid #1ecad455;border-top-color:#1ecad4;border-radius:50%;animation:s .8s linear infinite}
@keyframes s{to{transform:rotate(1turn)}}@media (prefers-reduced-motion:reduce){.spin{animation:none}}
</style>`;

/** A plain page saying what happened, with the way back. */
const page = (title: string, text: string): string => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>hopper — ${esc(title)}</title>${FAVICON_LINK}${LOOK}<main>
<h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/">Back to hopper</a></p></main>`;

/**
 * The callback's answer: post the ticket with this browser's binding (kept in localStorage when the
 * sign-in began), store the session token, go to the UI. Ticket is hex: safe inline.
 */
const ticketPage = (ticket: string): string => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>hopper — signing in</title>${FAVICON_LINK}${LOOK}
<main><div class="spin" id="s"></div><p id="m">Signing in…</p></main><script>
(async () => {
  let binding = null;
  try { binding = localStorage.getItem('jh_sign_in'); localStorage.removeItem('jh_sign_in'); } catch (e) {}
  const res = await fetch('/ui/auth/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: '${ticket}', binding: binding || '' }) });
  const out = await res.json().catch(() => ({}));
  if (res.ok) { try { localStorage.setItem('jh_session', out.token); } catch (e) {} location.replace('/'); return; }
  document.getElementById('s').remove();
  document.getElementById('m').textContent = (out.error || 'Sign-in failed') + '. Start again from the hopper page in this browser.';
})();
</script><noscript>JavaScript is needed to keep the UI session.</noscript>`;

const html = (reply: FastifyReply, status: number, body: string) =>
  reply.code(status).type('text/html; charset=utf-8').header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').send(body);

export function registerSignInRoutes(parent: FastifyInstance, o: {
  sessions: UiSessions; signIn: SignIn; instance: Pick<InstanceStore, 'loginCodes'>; clock: Clock;
  /** The user an identity signs in as (issue #158): linked, or a new one. */
  userFor: (who: Identity) => Promise<User>;
  /** A GitHub sign-in's connection, handed to the session's user (issue #214). */
  connect: (userId: string, connection: Connection) => void;
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

  /** A session for `who`, as its user, answered as JSON: the UI stores the token. A GitHub sign-in's connection becomes the user's. */
  const started = async (reply: FastifyReply, who: Identity, role: UiRole, connection?: Connection, extra: Record<string, unknown> = {}) => {
    const user = await o.userFor(who);
    if (connection) o.connect(user.id, connection);
    const s = sessions.create({ role, identity: who, userId: user.id });
    const shown = sessionUser(s, user.name);
    console.warn(`hopper: UI session started: ${who.realm} ${shown.identity} as user ${user.id}, role ${role}`);
    return reply.header('cache-control', 'no-store').send({ ...extra, token: s.token, expiresAt: s.expiresAt, user: shown });
  };
  const fromSignInOrigin = (req: FastifyRequest): boolean => req.headers.origin?.toLowerCase() === signIn.origin();
  // Nothing comes back from an identity provider, so these answer on any UI origin, not only the sign-in origin.
  const fromUiOrigin = (req: FastifyRequest): boolean => { const x = req.headers.origin?.toLowerCase(); return x !== undefined && o.isUiOrigin(x); };

  // Origin may be null (a local file posts it); the code is the credential.
  app.post('/ui/login', async (req, reply) => {
    const parsed = loginBody.safeParse(req.body);
    if (!signIn.local) return o.refuse(req, reply, 'local sign-in is off in the sign-in config');
    const userId = parsed.success ? useLoginCode(o.instance, o.clock, parsed.data.code) : undefined;
    if (userId === undefined) return o.refuse(req, reply, 'wrong, used, expired or missing login code');
    const s = sessions.create({ role: 'admin', identity: LOCAL_IDENTITY, userId });
    console.warn(`hopper: UI session started: local login code as user ${userId} (${o.userName(userId)}), role admin`);
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
      .send(loginPage(s.token));
  });

  // No credential: the exact Origin keeps another site from minting sessions in a visitor's browser.
  app.post('/ui/auth/none', async (req, reply) => {
    if (signIn.none === null) return o.refuse(req, reply, 'no sign-in is off in the sign-in config');
    if (!fromUiOrigin(req)) return o.refuse(req, reply, `origin ${req.headers.origin ?? '(none)'} not allowed`);
    return started(reply, NO_SIGN_IN_IDENTITY, signIn.none);
  });

  app.post('/ui/auth/password', async (req, reply) => {
    if (!signIn.password) return o.refuse(req, reply, 'password sign-in is off: no LDAP realm is on (Settings → Sign-in)');
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

  // The credential is the token the auth gateway adds to the request; the exact Origin keeps another site
  // from minting sessions in a browser the gateway lets through.
  app.post('/ui/auth/gateway', async (req, reply) => {
    if (!signIn.gateway) return o.refuse(req, reply, 'no gateway realm is on (Settings → Sign-in)');
    if (!fromUiOrigin(req)) return o.refuse(req, reply, `origin ${req.headers.origin ?? '(none)'} not allowed`);
    const r = await signIn.checkGateway(req.headers);
    if (!r.ok) {
      const who = r.who ? ` (${r.who.realm} ${r.who.subject})` : '';
      if (r.status === 403) return o.refuse(req, reply, `${r.error}${who}`);
      console.warn(`hopper: gateway sign-in failed: ${r.error}`);
      return reply.code(r.status).send({ error: r.error });
    }
    return started(reply, r.who, r.role);
  });

  // A GitHub realm (issue #214): the code comes back as JSON; no identity provider sends the
  // browser anywhere, so any UI origin may begin it. The binding keeps the session for this browser.
  app.post('/ui/auth/:name/device', async (req, reply) => {
    if (!fromUiOrigin(req)) return o.refuse(req, reply, `origin ${req.headers.origin ?? '(none)'} not allowed`);
    const { name } = parseWith(nameParams, req.params);
    try {
      return reply.header('cache-control', 'no-store').send(await signIn.beginDevice(name, parseWith(deviceStartBody, req.body).binding));
    } catch (e) {
      if (e instanceof SignInRefused) return reply.code(e.status).send({ error: e.message });
      console.warn(`hopper: sign-in with ${name} could not start: ${(e as Error).message}`);
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  // Polled every 2 s while the person enters the code: not counted against the sign-in rate limit. Only
  // the browser holding the flow's binding (random, never sent anywhere else) gets anything from it.
  app.post('/ui/auth/device/poll', { config: { rateLimit: false } }, async (req, reply) => {
    if (!fromUiOrigin(req)) return o.refuse(req, reply, `origin ${req.headers.origin ?? '(none)'} not allowed`);
    const { flow, binding } = parseWith(devicePollBody, req.body);
    const r = signIn.pollDevice(flow, binding);
    if (!r) return o.refuse(req, reply, 'unknown, finished or expired sign-in, or another browser began it');
    if (r.state === 'waiting') return reply.header('cache-control', 'no-store').send(r);
    if (r.state === 'failed') {
      const who = r.who ? ` (${r.who.realm} ${r.who.username ?? r.who.subject})` : '';
      console.warn(`hopper: device sign-in refused${who}: ${r.error}`);
      return reply.code(r.status).send({ state: 'failed', error: r.error });
    }
    return started(reply, r.who, r.role, r.connection, { state: 'signed-in' });
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
    return started(reply, r.who, r.role, r.connection);
  });

  app.get('/ui/auth/:name/metadata', async (req, reply) => {
    const p = signIn.redirectRealm(parseWith(nameParams, req.params).name);
    if (!p?.metadata) return reply.code(404).send({ error: 'no SAML realm by that name is on' });
    return reply.type('application/samlmetadata+xml; charset=utf-8').send(p.metadata());
  });
}
