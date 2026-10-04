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

/** True when this page was reached on a LAN name, not on loopback. */
export const onLan = (): boolean => !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
