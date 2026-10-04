// Logging a browser in (design.md "UI session and mutations", "Reaching the UI across the LAN"):
// the one-time login code goes to POST /ui/login as a plain form, whose answer stores the session
// token and reloads. A device link carries the code in the URL fragment, never sent to a server.

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

export const signInPath = (provider: string, binding: string): string => `/ui/auth/${encodeURIComponent(provider)}/start?binding=${binding}`;
export const BINDING_KEY = 'jh_sign_in';

/**
 * Navigates away: to the provider through the daemon. The binding is kept in this origin's
 * localStorage, so sign-in must start on the sign-in origin: elsewhere, go there first.
 */
export function beginSignIn(provider: string, origin: string): void {
  if (location.origin !== origin) { location.assign(origin); return; }
  const binding = newBinding();
  try { localStorage.setItem(BINDING_KEY, binding); } catch { /* storage blocked: the sign-in will be refused at the end */ }
  location.assign(signInPath(provider, binding));
}

/** True when this page was reached on a LAN name, not on loopback. */
export const onLan = (): boolean => !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
