// Grants and API tokens on Users & access → API tokens (issues #718, #881): what each listed grant and token says, the roles a
// person may mint one with, and the scopes a person ticks (issue #909): every scope of the registry is a box, a preset
// ticks its boxes, and a wildcard a preset holds (`*:read`, `*`) stays one until a box it ticks is cleared. The tokens
// themselves are shown once, right after the mint; the list never holds them.
import type { ApiGrantView, ApiTokenView, DeviceGrantView, GrantLimits, ScopePermission, ScopeRegistry, UiRole } from './wire.ts';

const ROLES: readonly UiRole[] = ['viewer', 'operator', 'admin'];

/** A date and time in the viewer's own form. */
const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** The roles a person with `role` may give a grant: theirs and the ones below it. */
export const mintableRoles = (role: UiRole | undefined): UiRole[] => (role ? ROLES.slice(0, ROLES.indexOf(role) + 1) : []);

/** An exchanged token's line: its role, whether it is a box token (issue #795), when it ends, and when it was last used. */
export const apiTokenLine = (t: ApiTokenView): string =>
  `${t.role}${t.box ? ' · box token' : ''} · ends ${when(t.expiresAt)}${t.lastUsedAt === t.startedAt ? ' · not used yet' : ` · last used ${when(t.lastUsedAt)}`}`;

/** What a grant's limits say (issue #892, "Grant limits"), as parts of a line: none when it has none. */
export const limitsParts = (l: GrantLimits | undefined): string[] => [
  ...(l?.repos?.length ? [`only ${l.repos.join(', ')}`] : []), ...(l?.sources?.length ? [`only the job sources ${l.sources.join(', ')}`] : []),
];

/** The limits a person typed (issue #892): repositories and job sources, each list by commas or spaces; none when both are empty. */
export function typedLimits(repos: string, sources: string): GrantLimits | undefined {
  const list = (s: string): string[] => s.split(/[\s,]+/).filter(Boolean);
  const r = list(repos);
  const src = list(sources);
  return r.length || src.length ? { ...(r.length ? { repos: r } : {}), ...(src.length ? { sources: src } : {}) } : undefined;
}

/**
 * A grant's line (issue #881): its role, box flag, whether it is bound to its agent's key (issue #892), its limits (issue
 * #892), when it was made, when it was last used and from where, and when it ends.
 */
export const grantLine = (g: ApiGrantView): string => [
  g.role, ...(g.box ? ['box'] : []), ...(g.jkt ? ['bound to its agent\'s key'] : []), ...limitsParts(g.limits), `made ${when(g.createdAt)}`,
  g.lastUsedAt === undefined ? 'not used yet' : `last used ${when(g.lastUsedAt)}${g.lastUsedFrom ? ` from ${g.lastUsedFrom}` : ''}`,
  g.endsAt === null ? 'no fixed end' : `ends ${when(g.endsAt)}`,
].join(' · ');

/**
 * Whether the pattern covers the scope: `<area>:<act>`, `<area>:*`, `*:<act>` or `*`; a route's scope covers each of its
 * actions' (`vault:edit` covers `vault:edit.approve-template`). The same rule as the server's
 * (src/domain/token-scopes.ts), which the UI may not import at runtime.
 */
const covers = (pattern: string, scope: string): boolean => {
  if (pattern === '*') return true;
  const [area, act] = pattern.split(':');
  const [needArea, needAct = ''] = scope.split(':');
  return (area === '*' || area === needArea) && (act === '*' || act === needAct || needAct.startsWith(`${act}.`));
};

/** Whether the patterns cover the scope: its box is ticked. */
export const scopeTicked = (patterns: readonly string[], scope: string): boolean => patterns.some((p) => covers(p, scope));

/** Every permission of the registry, in its sections' order. */
export const permissionsOf = (registry: ScopeRegistry): ScopePermission[] => registry.sections.flatMap((s) => s.permissions);

/**
 * The patterns after a person ticks or clears one scope's box. A tick adds the scope, in place of the scopes it covers
 * (a route's scope, of its actions'). A clear takes it out, with the scopes it covers; a wildcard or route scope that
 * covered it gives way to the registry's scopes it covered, less the cleared one and those that cover it.
 */
export function toggleScope(patterns: readonly string[], scope: string, on: boolean, known: readonly string[]): string[] {
  if (on) return scopeTicked(patterns, scope) ? [...patterns] : [...patterns.filter((p) => !covers(scope, p)), scope];
  const kept = [...new Set(patterns.flatMap((p) => (!covers(p, scope) ? [p] : known.filter((k) => covers(p, k) && !covers(k, scope)))))]
    .filter((p) => !covers(scope, p));
  return kept.filter((p) => !kept.some((q) => q !== p && covers(q, p)));
}

/**
 * The ticked permissions that are box actions: with any, the grant is a box grant (issue #795). An action's is named
 * only when its route's scope is not ticked as well.
 */
export const boxPermissions = (patterns: readonly string[], registry: ScopeRegistry): ScopePermission[] =>
  permissionsOf(registry).filter((p) => p.box && scopeTicked(patterns, p.scope) && !(p.parent !== undefined && scopeTicked(patterns, p.parent)));

/** The preset the patterns are, as a set, or undefined. */
export const presetOfScopes = (patterns: readonly string[], registry: ScopeRegistry): string | undefined =>
  registry.presets.find((p) => p.scopes.length === patterns.length && p.scopes.every((s) => patterns.includes(s)))?.id;

/** The user code a link to Users & access → API tokens holds (issue #892): `#users-access/api-tokens/BCDF-GHJK` → `BCDF-GHJK`; '' when none. */
export const deviceCodeOfHash = (hash: string): string => decodeURIComponent(hash.replace(/^#/, '').split('/')[2] ?? '');

/**
 * What a device grant request asks for (issue #892), in one line: its role (`as`, the person's, when it names none), box,
 * preset, scopes, limits, how long it lives, who asked and when the request ends. Box: named, or its preset's.
 */
export function deviceAskLine(v: DeviceGrantView, as: UiRole | undefined, registry?: ScopeRegistry): string {
  const box = v.ask.box ?? registry?.presets.find((p) => p.id === v.ask.preset)?.box ?? false;
  return [
    v.ask.role ?? `${as ?? 'your role'} (your role)`, ...(box ? ['box'] : []), ...(v.ask.jkt ? ['bound to the asking agent\'s key'] : []), ...(v.ask.preset ? [`preset ${v.ask.preset}`] : []),
    ...(v.ask.scopes?.length ? [`scopes ${v.ask.scopes.join(' ')}`] : []), ...limitsParts(v.ask.limits),
    v.ask.days === null ? 'no fixed end' : `lives ${v.ask.days ?? 90} days at most`, `asked from ${v.from}`, `request ends ${when(v.expiresAt)}`,
  ].join(' · ');
}
