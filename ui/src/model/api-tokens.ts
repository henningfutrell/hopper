// Grants and API tokens on Settings → API tokens (issues #718, #881): what each listed grant and token says, the roles a
// person may mint one with, and the scopes a person ticks (issue #909): every scope of the registry is a box, a preset
// ticks its boxes, and a wildcard a preset holds (`*:read`, `*`) stays one until a box it ticks is cleared. The tokens
// themselves are shown once, right after the mint; the list never holds them.
import type { ApiGrantView, ApiTokenView, ScopePermission, ScopeRegistry, UiRole } from './wire.ts';

const ROLES: readonly UiRole[] = ['viewer', 'operator', 'admin'];

/** A date and time in the viewer's own form. */
const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** The roles a person with `role` may give a grant: theirs and the ones below it. */
export const mintableRoles = (role: UiRole | undefined): UiRole[] => (role ? ROLES.slice(0, ROLES.indexOf(role) + 1) : []);

/** An exchanged token's line: its role, whether it is a box token (issue #795), when it ends, and when it was last used. */
export const apiTokenLine = (t: ApiTokenView): string =>
  `${t.role}${t.box ? ' · box token' : ''} · ends ${when(t.expiresAt)}${t.lastUsedAt === t.startedAt ? ' · not used yet' : ` · last used ${when(t.lastUsedAt)}`}`;

/** A grant's line (issue #881): its role, box flag, when it was made, when it was last used and from where, and when it ends. */
export const grantLine = (g: ApiGrantView): string => [
  g.role, ...(g.box ? ['box'] : []), `made ${when(g.createdAt)}`,
  g.lastUsedAt === undefined ? 'not used yet' : `last used ${when(g.lastUsedAt)}${g.lastUsedFrom ? ` from ${g.lastUsedFrom}` : ''}`,
  g.endsAt === null ? 'no fixed end' : `ends ${when(g.endsAt)}`,
].join(' · ');

/**
 * Whether the pattern covers the scope: `<area>:<act>`, `<area>:*`, `*:<act>` or `*`. The same rule as the server's
 * (src/domain/token-scopes.ts), which the UI may not import at runtime.
 */
const covers = (pattern: string, scope: string): boolean => {
  if (pattern === '*') return true;
  const [area, act] = pattern.split(':');
  const [needArea, needAct] = scope.split(':');
  return (area === '*' || area === needArea) && (act === '*' || act === needAct);
};

/** Whether the patterns cover the scope: its box is ticked. */
export const scopeTicked = (patterns: readonly string[], scope: string): boolean => patterns.some((p) => covers(p, scope));

/** Every permission of the registry, in its sections' order. */
export const permissionsOf = (registry: ScopeRegistry): ScopePermission[] => registry.sections.flatMap((s) => s.permissions);

/**
 * The patterns after a person ticks or clears one scope's box. A tick adds the scope. A clear takes it out; a wildcard
 * that covered it gives way to the registry's scopes it covered, less the cleared one.
 */
export function toggleScope(patterns: readonly string[], scope: string, on: boolean, known: readonly string[]): string[] {
  if (on) return scopeTicked(patterns, scope) ? [...patterns] : [...patterns, scope];
  const kept = patterns.flatMap((p) => (p === scope ? [] : covers(p, scope) ? known.filter((k) => covers(p, k)) : [p]));
  return [...new Set(kept)].filter((p) => p !== scope);
}

/** The ticked permissions that are box actions: with any, the grant is a box grant (issue #795). */
export const boxPermissions = (patterns: readonly string[], registry: ScopeRegistry): ScopePermission[] =>
  permissionsOf(registry).filter((p) => p.box && scopeTicked(patterns, p.scope));

/** The preset the patterns are, as a set, or undefined. */
export const presetOfScopes = (patterns: readonly string[], registry: ScopeRegistry): string | undefined =>
  registry.presets.find((p) => p.scopes.length === patterns.length && p.scopes.every((s) => patterns.includes(s)))?.id;
