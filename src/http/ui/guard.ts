// The checks every UI mutation must pass (design.md "UI session and mutations" 5). Headers only,
// so it runs before the body is parsed. The custom session header is the CSRF defence: a
// cross-site page can neither set it nor read the token.
import type { IncomingHttpHeaders } from 'node:http';
import type { UiSessions } from './sessions.ts';

export const SESSION_HEADER = 'x-jobhopper-session';

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? undefined : v);

/** Why the request is refused, or null when it may mutate. */
export function mutationRefusal(headers: IncomingHttpHeaders, port: number, sessions: UiSessions): string | null {
  if (!sessions.find(one(headers[SESSION_HEADER]))) return `missing or invalid ${SESSION_HEADER}`;
  const origin = one(headers.origin);
  if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return `origin ${origin ?? '(none)'} not allowed`;
  const site = one(headers['sec-fetch-site']);
  if (site !== undefined && site !== 'same-origin') return `sec-fetch-site ${site} not allowed`;
  const type = one(headers['content-type'])?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') return `content-type ${type ?? '(none)'} not allowed; send application/json`;
  return null;
}
