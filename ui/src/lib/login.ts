// Logging a browser in (design.md "UI session and mutations", "Reaching the UI across the LAN"):
// the one-time login code goes to POST /ui/login as a plain form, whose answer stores the session
// token and reloads. A device link carries the code in the URL fragment, never sent to a server. No
// sign-in, password sign-in and a gateway realm answer JSON with the token (design.md "Sign-in", issues #53, #215).
import type { SessionView } from '../model/wire.ts';

const CODE = /^[0-9a-f]{64}$/;

/** The login code in a `#login=<code>` fragment, or null. */
export function loginCodeFromHash(hash: string): string | null {
  if (!hash.startsWith('#login=')) return null;
  const code = hash.slice('#login='.length);
  return CODE.test(code) ? code : null;
}

/** Navigates away: POST /ui/login with the code, same origin. */
export function submitLogin(code: string): void {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = '/ui/login';
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'code';
  input.value = code.trim();
  form.append(input);
  document.body.append(form);
  form.submit();
}

/** A fresh sign-in binding (design.md "Sign-in"): 32 random bytes, base64url. Only this browser keeps it. */
export function newBinding(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const signInPath = (realm: string, binding: string): string => `/ui/auth/${encodeURIComponent(realm)}/start?binding=${binding}`;
export const BINDING_KEY = 'jh_sign_in';

/**
 * Navigates away: to the realm's identity provider through the daemon. The binding is kept in this origin's
 * localStorage, so sign-in must start on the sign-in origin: elsewhere, go there first.
 */
export function beginSignIn(realm: string, origin: string): void {
  if (location.origin !== origin) { location.assign(origin); return; }
  const binding = newBinding();
  try { localStorage.setItem(BINDING_KEY, binding); } catch { /* storage blocked: the sign-in will be refused at the end */ }
  location.assign(signInPath(realm, binding));
}

/** True when the UI should take a no-sign-in session by itself: logged out, and the sign-in config's `none` is on. */
export const wantsNoSignIn = (authed: boolean, offer: Pick<SessionView['signIn'], 'none'> | null): boolean => !authed && (offer?.none ?? null) !== null;

/** True when the UI should take a session from the auth gateway's token by itself: logged out, and a gateway realm is on. */
export const wantsGatewaySignIn = (authed: boolean, offer: Pick<SessionView['signIn'], 'gateway'> | null): boolean => !authed && (offer?.gateway ?? false);

/** POST a sign-in that answers `{ token }` as JSON (no sign-in, password); keeps the token. Resolves the error, or null. */
async function jsonSignIn(path: string, body: unknown): Promise<string | null> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({})) as { token?: string; error?: string };
  if (!res.ok || !out.token) return res.status === 429 ? 'too many sign-in attempts; wait a minute' : (out.error ?? `${res.status}`);
  try { localStorage.setItem('jh_session', out.token); } catch { return 'browser storage is blocked: the session cannot be kept'; }
  return null;
}

export const signInWithoutCredential = (): Promise<string | null> => jsonSignIn('/ui/auth/none', {});
/** The auth gateway in front of the hopper adds the token to this request; the daemon checks it. */
export const signInThroughGateway = (): Promise<string | null> => jsonSignIn('/ui/auth/gateway', {});
export const signInWithPassword = (username: string, password: string): Promise<string | null> => jsonSignIn('/ui/auth/password', { username, password });

/** True when this page was reached on a LAN name, not on loopback. */
export const onLan = (): boolean => !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
