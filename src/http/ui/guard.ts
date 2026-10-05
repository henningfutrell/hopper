// The checks every UI mutation must pass (design.md "UI session and mutations" 5, "Sign-in" Roles).
// Headers only, so it runs before the body is parsed. The custom session header is the CSRF
// defence: a cross-site page can neither set it nor read the token.
import type { IncomingHttpHeaders } from 'node:http';
import { roleAllows, type UiRole } from '../../domain/types.ts';
import { uiOrigins, type Lan } from '../reach.ts';
import type { UiSessions } from './sessions.ts';

export const SESSION_HEADER = 'x-hopper-session';

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? undefined : v);

/** Why the request is refused (`needs`: the session is live but its role is short), or null when it may mutate. */
export function mutationRefusal(headers: IncomingHttpHeaders, port: number, lan: Lan, sessions: UiSessions, needs: UiRole): { why: string; needs?: UiRole } | null {
  const session = sessions.find(one(headers[SESSION_HEADER]));
  if (!session) return { why: `missing or invalid ${SESSION_HEADER}` };
  const origin = one(headers.origin)?.toLowerCase();
  if (origin === undefined || !uiOrigins(port, lan).includes(origin)) return { why: `origin ${origin ?? '(none)'} not allowed` };
  const site = one(headers['sec-fetch-site']);
  if (site !== undefined && site !== 'same-origin') return { why: `sec-fetch-site ${site} not allowed` };
  const type = one(headers['content-type'])?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') return { why: `content-type ${type ?? '(none)'} not allowed; send application/json` };
  if (!roleAllows(session.role, needs)) return { why: `role ${session.role} may not do this; it needs ${needs}`, needs };
  return null;
}
