// The Vault settings page's model (issue #558): what a secret's card says — its scope, who set it and when, who last
// changed it — and whether a name is one the hopper takes. A secret here is only its metadata: there is no value to show.
import type { BoxTemplateView, VaultSecret } from './wire.ts';

/** The hopper's rule for a vault secret's name (src/domain/vault.ts). */
const NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** Why `name` is no vault secret name, or undefined. */
export function nameProblem(name: string): string | undefined {
  if (!name) return 'a name is needed';
  if (name.length > 64) return 'at most 64 characters';
  if (!NAME.test(name)) return 'a letter, then letters, digits, _ . or -';
  return undefined;
}

/** A date and time in the viewer's own form. */
const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export interface Fact { label: string; value: string }

/** The card's facts: the scope when said, who set it, and who changed it when that came later. */
export function secretFacts(s: VaultSecret): Fact[] {
  return [
    ...(s.scope ? [{ label: 'Scope', value: s.scope }] : []),
    { label: 'Set by', value: `${s.setBy} · ${when(s.createdAt)}` },
    ...(s.changedAt !== s.createdAt ? [{ label: 'Changed by', value: `${s.changedBy} · ${when(s.changedAt)}` }] : []),
  ];
}

/** The image a new box template starts with: the published sandbox box. */
export const DEFAULT_BOX_IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';

/** What a box template's card says of its approval: approved, or what waits for a person. */
export function approvalText(t: BoxTemplateView): string {
  if (!t.approval) return 'not approved yet: its boxes get nothing from the vault';
  const waits = [...(t.pending.image ? ['a new image'] : []), ...(t.pending.secrets.length ? [`${t.pending.secrets.join(', ')} added`] : [])];
  return waits.length ? `waits for approval: ${waits.join('; ')}` : 'approved';
}
