// The Vault settings page's model (issue #558): what a secret's card says — its scope, who set it and when, who last
// changed it — and whether a name is one the hopper takes. A secret here is only its metadata: there is no value to show.
import type { Asset, OperationProfile, TemplateRadius, TemplateView, VaultSecret } from './wire.ts';

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

/** The card's facts: what it mints for or its scope when said, who set it, who changed it when that came later, and its last use. */
export function secretFacts(s: VaultSecret): Fact[] {
  return [
    ...(s.mints ? [{ label: 'Mints for', value: `${s.mints.kind} ${s.mints.name}` }] : []),
    ...(s.scope ? [{ label: 'Scope', value: s.scope }] : []),
    { label: 'Set by', value: `${s.setBy} · ${when(s.createdAt)}` },
    ...(s.changedAt !== s.createdAt ? [{ label: 'Changed by', value: `${s.changedBy} · ${when(s.changedAt)}` }] : []),
    ...(s.lastUsed ? [{ label: s.mints ? 'Last minted' : 'Last delivered', value: `${s.lastUsed.machine} · job ${s.lastUsed.job.slice(0, 8)} · ${when(s.lastUsed.at)}` }] : []),
  ];
}

const MINTS = /^(cluster|aws-account)\/([A-Za-z0-9][A-Za-z0-9._+=,-]{0,199})$/;

/**
 * What a minting credential mints for (issue #580), as typed: `cluster/NAME` or `aws-account/ID`. Undefined when empty
 * (a plain secret); a string says why it is not one.
 */
export function mintsOf(said: string): Asset | string | undefined {
  const v = said.trim();
  if (!v) return undefined;
  const m = MINTS.exec(v);
  return m ? { kind: m[1] as Asset['kind'], name: m[2]! } : 'write it as cluster/NAME or aws-account/ID';
}

/** The image a new template starts with: the published sandbox box. */
export const DEFAULT_BOX_IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';

/** `write on cluster x`. */
export const profileText = (p: OperationProfile): string => `${p.operation} on ${p.asset.kind} ${p.asset.name}`;

/** The hopper's high-radius operations (src/blast-radius/template.ts): a profile of one needs its own explicit approval (issue #584). */
const HIGH = ['write', 'sync', 'apply'];
export const highRadius = (p: OperationProfile): boolean => HIGH.includes(p.operation);

/** The template's profiles that wait for their own explicit approval: approving the template does not approve them. */
export const explicitApprovals = (t: TemplateView): OperationProfile[] => t.pending.profiles.filter(highRadius);

/** What a template's card says of its approval: approved, or what waits for a person. */
export function approvalText(t: TemplateView): string {
  if (!t.approval) return 'not approved yet: its boxes get nothing from the vault';
  const waits = [
    ...(t.pending.image ? ['a new image'] : []), ...(t.pending.secrets.length ? [`${t.pending.secrets.join(', ')} added`] : []),
    ...t.pending.profiles.map((p) => `${profileText(p)}${highRadius(p) ? ' (explicit)' : ''}`),
  ];
  return waits.length ? `waits for approval: ${waits.join('; ')}` : 'approved';
}

/** A template's rating in a few words (issue #584): the level, then the reasons that set it. */
export const radiusText = (r: TemplateRadius): string => `${r.level} radius: ${r.reasons.join('; ')}`;
