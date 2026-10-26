// HTTP to the daemon. Reads are GETs, open on loopback and carrying the UI session header across
// the LAN; mutations only through POST /ui/api/* with JSON and that header (design.md "UI session
// and mutations", "Reaching the UI across the LAN"). Every answer is checked to be this page's hopper's before it is
// read (issue #1295, lib/instance.ts): another hopper's is dropped, and nothing more is sent to it.
import type { SessionView } from '@/model/wire';
import { checkInstance, INSTANCE_HEADER, refuseOtherHopper } from './instance';

const TOKEN_KEY = 'jh_session';

export const readToken = (): string | null => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const clearToken = (): void => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked: stay logged out */ } };

export class SessionRejected extends Error {}

/** What the store does when the daemon says the stored session is over (issue #439): sign in again. */
let sessionEnded: () => void = () => {};
export const onSessionEnded = (fn: () => void): void => { sessionEnded = fn; };
const rejected = (why: string): SessionRejected => { clearToken(); sessionEnded(); return new SessionRejected(why); };
/** A live session whose role is short of what the mutation needs: the session stays. */
export class RoleRefused extends Error {}

/** How long a read waits for its whole answer before it fails (issue #1182): a stalled read is an error, never a wait without end. */
export const READ_TIMEOUT_MS = 15_000;

/** A read that got no whole answer in its time. */
export class ReadTimedOut extends Error {}

/**
 * A read. It fails with ReadTimedOut when the answer is not all in after `timeoutMs`; `signal` cancels it, and then it
 * fails with the AbortError fetch throws.
 */
export async function get<T>(path: string, { signal, timeoutMs = READ_TIMEOUT_MS }: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  refuseOtherHopper();
  const token = readToken();
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
  const cancel = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort(); else signal?.addEventListener('abort', cancel);
  try {
    const res = await fetch(path, { signal: ctrl.signal, ...(token ? { headers: { 'x-hopper-session': token } } : {}) });
    checkInstance(res.headers.get(INSTANCE_HEADER));
    const body = await res.json().catch((e: unknown) => { if (ctrl.signal.aborted) throw e; return {}; });
    // Across the LAN a read needs a live session: 401 with one sent means it ended.
    if (res.status === 401 && token) throw rejected(body.error || 'session ended');
    if (!res.ok) throw new Error(body.error || `${res.status} ${path}`);
    return body as T;
  } catch (e) {
    if (timedOut) throw new ReadTimedOut(`no answer in ${Math.round(timeoutMs / 1000)} s`);
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/**
 * A read saved as a file (issue #2840: an export): the answer, with the session header as every read, handed to the
 * browser to save under the name its `content-disposition` gives, else `fallback`.
 */
export async function download(path: string, fallback: string): Promise<void> {
  refuseOtherHopper();
  const token = readToken();
  const res = await fetch(path, token ? { headers: { 'x-hopper-session': token } } : {});
  checkInstance(res.headers.get(INSTANCE_HEADER));
  if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error || `${res.status} ${path}`);
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallback;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** A mutation; `signal` cancels it (the request closes, and the daemon ends what it ran for it), failing with fetch's AbortError. */
export async function post<T = unknown>(path: string, body: unknown = {}, { signal }: { signal?: AbortSignal } = {}): Promise<T> {
  refuseOtherHopper();
  const res = await fetch(path, {
    method: 'POST', ...(signal ? { signal } : {}),
    headers: { 'content-type': 'application/json', 'x-hopper-session': readToken() ?? '' },
    body: JSON.stringify(body),
  });
  checkInstance(res.headers.get(INSTANCE_HEADER));
  const out = await res.json().catch(() => ({}));
  // Only the session guard's own refusal ends the session (issue #696): a 403 or 503 for anything else — Access denied,
  // OpenFGA down — is that change failing, and the person stays signed in.
  if (res.status === 403 && out.session === 'ended') throw rejected(out.error || 'session rejected');
  if (res.status === 403 && out.needs) throw new RoleRefused(out.error);
  if (!res.ok) throw new Error(out.error || `${res.status} ${path}`);
  return out as T;
}

/** A login code as a link per LAN name, for another device: `keep` again while it is live, else a fresh one. */
export const deviceLinks = (keep?: string) => post<{ links: string[] }>('/ui/api/device-link', keep === undefined ? {} : { keep });

/** The session the stored token names (or none), and the ways to sign in. Throws only when the daemon is unreachable. */
export async function readSession(): Promise<SessionView> {
  refuseOtherHopper();
  const token = readToken();
  const res = await fetch('/ui/api/session', token ? { headers: { 'x-hopper-session': token } } : {});
  checkInstance(res.headers.get(INSTANCE_HEADER));
  const out = await res.json().catch(() => ({})) as Partial<SessionView>;
  if (!res.ok || !out.signIn) throw new Error(`${res.status} /ui/api/session`);
  if (out.authenticated !== true && token) clearToken();
  return out as SessionView;
}
