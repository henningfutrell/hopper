// HTTP to the daemon. Reads are GETs, open on loopback and carrying the UI session header across
// the LAN; mutations only through POST /ui/api/* with JSON and that header (design.md "UI session
// and mutations", "Reaching the UI across the LAN").
import { onLan } from './login';

const TOKEN_KEY = 'jh_session';
export const LOGIN_CMD = 'bash ~/.local/lib/job-hopper/scripts/open-ui.sh';
/** How to log in from here: the command on this machine, a device link across the LAN. */
export const loginHint = (): string => (onLan() ? 'open a device link from a logged-in browser, or paste a login code' : `run ${LOGIN_CMD}`);

export const readToken = (): string | null => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const clearToken = (): void => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked: stay read-only */ } };

export class SessionRejected extends Error {}

export async function get<T>(path: string): Promise<T> {
  const token = readToken();
  const res = await fetch(path, token ? { headers: { 'x-jobhopper-session': token } } : {});
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${path}`);
  return body as T;
}

export async function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jobhopper-session': readToken() ?? '' },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (res.status === 403) { clearToken(); throw new SessionRejected(out.error || 'session rejected'); }
  if (!res.ok) throw new Error(out.error || `${res.status} ${path}`);
  return out as T;
}

/** The current login code as a link per LAN name, for another device. */
export const deviceLinks = () => post<{ links: string[] }>('/ui/api/device-link');

/** True when the stored token names a live UI session. Throws only when the daemon is unreachable. */
export async function sessionIsLive(): Promise<boolean> {
  const token = readToken();
  if (!token) return false;
  const res = await fetch('/ui/api/session', { headers: { 'x-jobhopper-session': token } });
  const out = await res.json().catch(() => ({}));
  const live = res.ok && out.authenticated === true;
  if (!live) clearToken();
  return live;
}
