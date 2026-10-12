// Token scopes (issue #881, design.md "Grants and refresh tokens" Scopes): what a grant's API tokens may use, named
// from the routes themselves so every route has one and none is left out. A read `GET /api/<area>/…` needs
// `<area>:read`; a mutation `POST /ui/api/<area>/…/<act>` needs `<area>:<act>` — the last fixed segment of its path —,
// and `POST /ui/api/<area>` alone needs `<area>:edit`. A grant holds patterns: `<area>:<act>`, `<area>:*`, `*:<act>`
// (`*:read`: every read), or `*`. A route that names no scope is closed to a grant's tokens: deny by default.
// A route whose body names one of several actions (issue #909: `action`, or `kind`) has a scope for each action too,
// `<area>:<act>.<action>` (`vault:edit.approve-template`): the route's scope covers all of them, an action's only its own.

/**
 * The scope a route needs, as Fastify registers it (`/ui/api/jobs/:id/approve` → `jobs:approve`) or the API reference
 * names it (`/ui/api/jobs/{id}/approve`); undefined: none.
 */
export function scopeOfRoute(method: string, route: string): string | undefined {
  const prefix = method === 'GET' ? '/api/' : method === 'POST' ? '/ui/api/' : undefined;
  if (prefix === undefined || !route.startsWith(prefix)) return undefined;
  const fixed = route.slice(prefix.length).split('/').filter((s) => s !== '' && !s.startsWith(':') && !s.startsWith('{'));
  const [area] = fixed;
  if (area === undefined) return undefined;
  if (method === 'GET') return `${area}:read`;
  return `${area}:${fixed.length > 1 ? fixed[fixed.length - 1] : 'edit'}`;
}

/** Every scope the routes need, sorted, once each. */
export const scopesOfRoutes = (routes: readonly { method: string; path: string }[]): string[] =>
  [...new Set(routes.map((r) => scopeOfRoute(r.method.toUpperCase(), r.path)).filter((s): s is string => s !== undefined))].sort();

/** An action as its scope names it: lower case, a hyphen for anything else (`approve-template`). */
export const actionWord = (action: string): string => action.toLowerCase().replace(/[^a-z0-9-]+/g, '-');

/** The scope of one action of a route whose scope is `routeScope`: `vault:edit` and `approve-template` → `vault:edit.approve-template`. */
export const scopeOfAction = (routeScope: string, action: string): string => `${routeScope}.${actionWord(action)}`;

const PATTERN = /^(\*|[a-z0-9-]+:(\*|[a-z0-9-]+(\.[a-z0-9-]+)?)|\*:[a-z0-9-]+(\.[a-z0-9-]+)?)$/;

/** Whether the scope pattern covers the scope; a route's scope covers each of its actions'. */
function covers(pattern: string, scope: string): boolean {
  if (pattern === '*') return true;
  const [area, act] = pattern.split(':');
  const [needArea, needAct = ''] = scope.split(':');
  return (area === '*' || area === needArea) && (act === '*' || act === needAct || needAct.startsWith(`${act}.`));
}

/** Whether a grant with these scope patterns may use a route, or the action of one, that needs `scope`. */
export const scopeAllows = (patterns: readonly string[], scope: string): boolean => patterns.some((p) => covers(p, scope));

/**
 * Whether the patterns cover the route's scope, or at least one of its actions' (issue #909): what the door checks,
 * before the body is read; the action itself is checked once it is (`scopeAllows` with `scopeOfAction`).
 */
export const scopeAllowsSome = (patterns: readonly string[], routeScope: string): boolean =>
  patterns.some((p) => covers(p, routeScope) || (p.includes('.') && covers(p.replace(/\.[a-z0-9-]+$/, ''), routeScope)));

/** Why a scope pattern is refused, or undefined: it is well formed and covers at least one scope a route needs. */
export function scopeProblem(pattern: string, known: readonly string[]): string | undefined {
  if (!PATTERN.test(pattern)) return `scope ${JSON.stringify(pattern)}: write <area>:<act>, <area>:*, *:<act> or *`;
  if (!known.some((s) => covers(pattern, s))) return `scope ${pattern} names no route: GET /api/api-tokens lists the scopes there are`;
  return undefined;
}
