// The checks every UI mutation must pass (design.md "UI session and mutations" 5, "Sign-in" Roles).
// Headers only, so it runs before the body is parsed. The custom session header is the CSRF
// defence: a cross-site page can neither set it nor read the token. An API token (issue #718, design.md
// "API tokens") comes in `Authorization` instead: no browser sends one by itself, and a cross-site page may set
// it only through a CORS preflight the hopper never allows, so the Origin checks are for the UI session alone.
import type { IncomingHttpHeaders } from 'node:http';
import { API_TOKEN_PREFIX, roleAllows, type UiRole } from '../../domain/types.ts';
import { uiOrigins, type Lan } from '../reach.ts';
import type { UiSession, UiSessions } from './sessions.ts';

export const SESSION_HEADER = 'x-hopper-session';

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? undefined : v);

/** The API token in `Authorization: Bearer …`, or undefined: none, or a bearer token that is not one (the API door's). */
export function apiTokenIn(headers: IncomingHttpHeaders): string | undefined {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(one(headers.authorization) ?? '');
  return m?.[1]?.startsWith(API_TOKEN_PREFIX) ? m[1] : undefined;
}

/** The request's session token: the UI session header, else an API token in `Authorization`. */
export const sessionTokenIn = (headers: IncomingHttpHeaders): string | undefined => one(headers[SESSION_HEADER]) ?? apiTokenIn(headers);

/**
 * The live session the headers carry: a UI session only in its header, an API token only in `Authorization` — each
 * where it was made to go, so neither stands in for the other.
 */
export function sessionIn(headers: IncomingHttpHeaders, sessions: UiSessions): UiSession | undefined {
  const header = one(headers[SESSION_HEADER]);
  if (header !== undefined) {
    const s = sessions.find(header);
    return s?.kind === 'ui' ? s : undefined;
  }
  const s = sessions.find(apiTokenIn(headers));
  return s?.kind === 'api' ? s : undefined;
}

/**
 * Why the request is refused, or null when it may mutate. `needs`: the session is live but its role is short. `session:
 * 'ended'`: there is no live session — the one refusal the UI reads as signed out (issue #696); any other 403 keeps it.
 * What Access says of an API token is asked after this (src/http/ui/index.ts): it is not headers only.
 */
export function mutationRefusal(headers: IncomingHttpHeaders, port: number, lan: Lan, sessions: UiSessions, needs: UiRole): { why: string; needs?: UiRole; session?: 'ended' } | null {
  const session = sessionIn(headers, sessions);
  if (!session) {
    return apiTokenIn(headers) === undefined || one(headers[SESSION_HEADER]) !== undefined
      ? { why: `missing or invalid ${SESSION_HEADER}`, session: 'ended' }
      : { why: 'the API token is unknown, revoked or expired', session: 'ended' };
  }
  if (session.kind === 'ui') {
    const origin = one(headers.origin)?.toLowerCase();
    if (origin === undefined || !uiOrigins(port, lan).includes(origin)) return { why: `origin ${origin ?? '(none)'} not allowed` };
    const site = one(headers['sec-fetch-site']);
    if (site !== undefined && site !== 'same-origin') return { why: `sec-fetch-site ${site} not allowed` };
  }
  const type = one(headers['content-type'])?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') return { why: `content-type ${type ?? '(none)'} not allowed; send application/json` };
  if (!roleAllows(session.role, needs)) return { why: `role ${session.role} may not do this; it needs ${needs}`, needs };
  return null;
}
