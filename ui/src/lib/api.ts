// HTTP to the daemon. Reads are open GETs; mutations only through POST /ui/api/* with JSON and
// the UI session header (design.md "UI session and mutations").

const TOKEN_KEY = 'jh_session';
export const LOGIN_CMD = 'bash ~/.local/lib/job-hopper/scripts/open-ui.sh';

export const readToken = (): string | null => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const clearToken = (): void => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked: stay read-only */ } };

export class SessionRejected extends Error {}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
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
