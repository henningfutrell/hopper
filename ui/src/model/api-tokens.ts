// API tokens on Settings → API tokens (issue #718): what each listed token says, and the roles a person may mint one with.
// The token itself is shown once, right after the mint; the list never holds it.
import type { ApiTokenView, UiRole } from './wire.ts';

const ROLES: readonly UiRole[] = ['viewer', 'operator', 'admin'];

/** A date and time in the viewer's own form. */
const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** The roles a person with `role` may give a token: theirs and the ones below it. */
export const mintableRoles = (role: UiRole | undefined): UiRole[] => (role ? ROLES.slice(0, ROLES.indexOf(role) + 1) : []);

/** The card's line: its role, when it ends, and when it was last used. */
export const apiTokenLine = (t: ApiTokenView): string =>
  `${t.role} · ends ${when(t.expiresAt)}${t.lastUsedAt === t.startedAt ? ' · not used yet' : ` · last used ${when(t.lastUsedAt)}`}`;
