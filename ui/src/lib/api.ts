// HTTP to the daemon. Reads are GETs, open on loopback and carrying the UI session header across
// the LAN; mutations only through POST /ui/api/* with JSON and that header (design.md "UI session
// and mutations", "Reaching the UI across the LAN").
import type { SessionView } from '@/model/wire';

const TOKEN_KEY = 'jh_session';
export const LOGIN_CMD = 'bash ~/.local/lib/hopper/scripts/open-ui.sh';

export const readToken = (): string | null => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const clearToken = (): void => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked: stay logged out */ } };

export class SessionRejected extends Error {}
/** A live session whose role is short of what the mutation needs: the session stays. */
export class RoleRefused extends Error {}

export async function get<T>(path: string): Promise<T> {
  const token = readToken();
  const res = await fetch(path, token ? { headers: { 'x-hopper-session': token } } : {});
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${path}`);
  return body as T;
}

export async function post<T = unknown>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hopper-session': readToken() ?? '' },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (res.status === 403 && out.needs) throw new RoleRefused(out.error);
  if (res.status === 403) { clearToken(); throw new SessionRejected(out.error || 'session rejected'); }
  if (!res.ok) throw new Error(out.error || `${res.status} ${path}`);
  return out as T;
}

/** A login code as a link per LAN name, for another device: `keep` again while it is live, else a fresh one. */
export const deviceLinks = (keep?: string) => post<{ links: string[] }>('/ui/api/device-link', keep === undefined ? {} : { keep });

/** The session the stored token names (or none), and the ways to sign in. Throws only when the daemon is unreachable. */
export async function readSession(): Promise<SessionView> {
  const token = readToken();
  const res = await fetch('/ui/api/session', token ? { headers: { 'x-hopper-session': token } } : {});
  const out = await res.json().catch(() => ({})) as Partial<SessionView>;
  if (!res.ok || !out.signIn) throw new Error(`${res.status} /ui/api/session`);
  if (out.authenticated !== true && token) clearToken();
  return out as SessionView;
}
