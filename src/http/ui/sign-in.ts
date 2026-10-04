// Sign-in through an identity provider (design.md "Sign-in: local, OIDC and SAML"); the flow itself
// is src/auth/index.ts. Routes, all on the sign-in origin:
//   GET  /ui/auth/<name>/start?binding=…  → 302 to the provider
//   GET  /ui/auth/<name>/callback         ← OIDC and GitHub send the browser back here
//   POST /ui/auth/<name>/callback         ← SAML posts its response here (assertion consumer service)
//   POST /ui/auth/complete                ← the callback page: { ticket, binding } → { token, … }
//   GET  /ui/auth/<name>/metadata         → SAML service provider metadata
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SignInRefused, type SignIn } from '../../auth/index.ts';
import type { UiRole } from '../../domain/types.ts';
import { parseWith } from '../errors.ts';
import { sessionUser, type UiSessions } from './sessions.ts';

const nameParams = z.object({ name: z.string() });
const startQuery = z.object({ binding: z.string().optional() });
const completeBody = z.object({ ticket: z.string(), binding: z.string() });

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A plain page saying what happened, with the way back. */
const page = (title: string, text: string): string => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>job-hopper — ${esc(title)}</title><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem">
<h1 style="font-size:1.2rem">${esc(title)}</h1><p>${esc(text)}</p><p><a href="/">Back to job-hopper</a></p>`;

/**
 * The callback's answer: post the ticket with this browser's binding (kept in localStorage when the
 * sign-in began), store the session token, go to the UI. Ticket is hex: safe inline.
 */
const ticketPage = (ticket: string): string => `<!doctype html><meta charset="utf-8"><title>job-hopper — signing in</title>
<body style="font-family:system-ui,sans-serif"><p id="m">Signing in…</p><script>
(async () => {
  let binding = null;
  try { binding = localStorage.getItem('jh_sign_in'); localStorage.removeItem('jh_sign_in'); } catch (e) {}
  const res = await fetch('/ui/auth/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket: '${ticket}', binding: binding || '' }) });
  const out = await res.json().catch(() => ({}));
  if (res.ok) { try { localStorage.setItem('jh_session', out.token); } catch (e) {} location.replace('/'); return; }
  document.getElementById('m').textContent = (out.error || 'Sign-in failed') + '. Start again from the job-hopper page in this browser.';
})();
</script><noscript>JavaScript is needed to keep the UI session.</noscript>`;

const html = (reply: FastifyReply, status: number, body: string) =>
  reply.code(status).type('text/html; charset=utf-8').header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').send(body);

export function registerSignInRoutes(app: FastifyInstance, o: {
  sessions: UiSessions; signIn: SignIn;
  refuse: (req: FastifyRequest, reply: FastifyReply, why: string, needs?: UiRole) => unknown;
}): void {
  const { signIn, sessions } = o;

  app.get('/ui/auth/:name/start', async (req, reply) => {
    const { name } = parseWith(nameParams, req.params);
    // The binding lives in this origin's localStorage; the provider returns to the sign-in origin.
    if (req.headers.host?.toLowerCase() !== new URL(signIn.origin()).host) {
      return html(reply, 409, page('Sign in on the sign-in address', `Open ${signIn.origin()} and sign in there.`));
    }
    try {
      return reply.header('cache-control', 'no-store').redirect(await signIn.begin(name, parseWith(startQuery, req.query).binding ?? ''), 302);
    } catch (e) {
      if (e instanceof SignInRefused) return html(reply, e.status, page('Cannot sign in', e.message));
      console.warn(`job-hopper: sign-in with ${name} could not start: ${(e as Error).message}`);
      return html(reply, 502, page('Cannot sign in', (e as Error).message));
    }
  });

  const callback = async (req: FastifyRequest, reply: FastifyReply) => {
    const { name } = parseWith(nameParams, req.params);
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, string> : undefined;
    const r = await signIn.callback(name, { url: new URL(req.url, signIn.origin()), ...(body ? { body } : {}) });
    if (!r.ok) {
      const who = r.who ? ` (${r.who.provider} ${r.who.email ?? r.who.username ?? r.who.subject})` : '';
      console.warn(`job-hopper: sign-in with ${name} refused${who}: ${r.error}`);
      return html(reply, r.status, page('Not signed in', r.error));
    }
    return html(reply, 200, ticketPage(r.ticket));
  };
  app.get('/ui/auth/:name/callback', callback);
  app.post('/ui/auth/:name/callback', callback);

  app.post('/ui/auth/complete', async (req, reply) => {
    if (req.headers.origin?.toLowerCase() !== signIn.origin()) return o.refuse(req, reply, `origin ${req.headers.origin ?? '(none)'} not allowed`);
    const { ticket, binding } = parseWith(completeBody, req.body);
    const r = signIn.complete(ticket, binding);
    if (!r) return o.refuse(req, reply, 'unknown, used or expired sign-in, or another browser began it');
    const s = sessions.create({ role: r.role, identity: r.who });
    console.warn(`job-hopper: UI session started: ${r.who.provider} ${sessionUser(s).name}, role ${r.role}`);
    return reply.header('cache-control', 'no-store').send({ token: s.token, expiresAt: s.expiresAt, user: sessionUser(s) });
  });

  app.get('/ui/auth/:name/metadata', async (req, reply) => {
    const p = signIn.provider(parseWith(nameParams, req.params).name);
    if (!p?.metadata) return reply.code(404).send({ error: 'no SAML identity provider by that name' });
    return reply.type('application/samlmetadata+xml; charset=utf-8').send(p.metadata());
  });
}
