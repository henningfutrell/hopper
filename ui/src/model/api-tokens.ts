// Grants and API tokens on Settings → API tokens (issues #718, #881): what each listed grant and token says, the roles a
// person may mint one with, and the scopes a person types. The tokens themselves are shown once, right after the mint;
// the list never holds them.
import type { ApiGrantView, ApiTokenView, UiRole } from './wire.ts';

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

/** The scopes a person typed: separated by spaces or commas, once each. */
export const parseScopes = (text: string): string[] => [...new Set(text.split(/[\s,]+/).filter((s) => s !== ''))];

/** Scope sets a person picks with one click. */
export const SCOPE_PRESETS: readonly { label: string; scopes: string }[] = [
  { label: 'Read only', scopes: '*:read' },
  { label: 'Answer questions and approve intake', scopes: '*:read questions:answer sources:intake' },
  { label: 'Everything', scopes: '*' },
];
