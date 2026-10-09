// The vault (issue #558, design.md "The vault"): a user's secrets, set once in the UI and never read back, kept sealed
// in the user's store under the token key. The types every part shares: a secret is only ever its metadata.
import type { OperationProfile } from './access.ts';
import type { TemplateRadius } from './blast-radius.ts';

/** A vault secret's name: a letter, then letters, digits, `_`, `.`, `-`; at most 64. */
export const VAULT_SECRET_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** The longest value the vault keeps: a key pair, a token, a PEM. */
export const VAULT_VALUE_MAX = 64 * 1024;
/** The longest scope: a line saying what the secret reaches. */
export const VAULT_SCOPE_MAX = 200;

/** One vault secret, as anything but the sealer sees it: its metadata, never its value. */
export interface VaultSecret {
  id: string;
  name: string;
  /** What it reaches, in the words of whoever set it (a cluster and namespace, an account and role). Absent: not said. */
  scope?: string;
  /** Who set it first, and when. */
  setBy: string;
  createdAt: string;
  /** Who last set its value or scope, and when. */
  changedBy: string;
  changedAt: string;
  /** When it was last delivered, to which machine, for which job (issue #558, slice 3). */
  lastUsed?: { at: string; machine: string; job: string };
}

/** `GET /api/vault`: never a value. */
export interface VaultView {
  secrets: VaultSecret[];
  /** The templates (issue #558, slice 2), each with what waits for a person. */
  templates: TemplateView[];
  /** Why no secret can be stored now (no token key); absent when one can. */
  problem?: string;
}

/**
 * A template (issue #558): an image and the vault secrets its boxes may ask for — the scope. The scope is the
 * template's alone, never a job's. A person approves it once; what it gives is what was approved, and only while the
 * image is the one approved.
 */
export interface Template {
  name: string;
  /** The image its boxes run: a full reference, as `podman run` takes it. */
  image: string;
  /** The scope: vault secret names. */
  secrets: string[];
  /**
   * The operation profiles its boxes may ask for (issue #584): approved in access, a read profile with the template, a
   * write, sync or apply profile only by its own explicit approval. Absent on a template saved before: none.
   */
  profiles?: OperationProfile[];
  savedBy: string;
  savedAt: string;
  /** The last approval: the image and scope a person approved, who and when. Absent: never approved. */
  approval?: { image: string; secrets: string[]; by: string; at: string };
}

/** A template as the vault shows it: what waits for a person, what its boxes may be given now, and its blast radius. */
export interface TemplateView extends Template {
  profiles: OperationProfile[];
  /** What waits for approval: secrets added since, whether the image is not the one approved, and the profiles access does not approve. */
  pending: { secrets: string[]; image: boolean; profiles: OperationProfile[] };
  /** The secrets its boxes may be given now: its scope, as far as it was approved, while its image is the approved one. */
  gives: string[];
  /** Rated from its profiles and its secrets (issue #584). */
  radius: TemplateRadius;
}

const sameProfile = (a: OperationProfile, b: OperationProfile): boolean => a.operation === b.operation && a.asset.kind === b.asset.kind && a.asset.name === b.asset.name;

/** The secrets a template's boxes may be given now: its scope, as far as it was approved, while its image is the approved one. */
export function givesOf(t: Template): string[] {
  const approved = t.approval?.secrets ?? [];
  return t.approval?.image !== t.image ? [] : t.secrets.filter((s) => approved.includes(s));
}

/** The template's view, with the profiles access approves it for (`approvedProfiles`) and its rating. */
export function templateView(t: Template, approvedProfiles: readonly OperationProfile[], radius: TemplateRadius): TemplateView {
  const approved = t.approval?.secrets ?? [];
  const image = t.approval?.image !== t.image;
  const profiles = t.profiles ?? [];
  return {
    ...t, profiles,
    pending: { secrets: t.secrets.filter((s) => !approved.includes(s)), image, profiles: profiles.filter((p) => !approvedProfiles.some((a) => sameProfile(a, p))) },
    gives: givesOf(t),
    radius,
  };
}

/** The vault (issue #558): its secrets, each one's value sealed, kept apart from its metadata and answered only by `sealed`. Kept beside the vault's types; domain/store.ts re-exports it. */
export interface VaultRepository {
  list(): VaultSecret[]; get(name: string): VaultSecret | undefined;
  /** Keeps a new secret, its value already sealed for its id. False (nothing written) when the name is taken. */
  add(secret: VaultSecret, sealed: string): boolean;
  /** Its value, sealed again or replaced, and its metadata; false when there is no such secret. */
  replace(secret: VaultSecret, sealed: string): boolean;
  /** The secret's sealed value; undefined when there is none. Never part of a secret. */
  sealed(id: string): string | undefined;
  /** True when there was one. */
  remove(name: string): boolean;
  /** The templates (issue #558), by name. */
  templates(): Template[]; template(name: string): Template | undefined;
  /** `removeTemplate`: true when there was one. */
  saveTemplate(t: Template): void; removeTemplate(name: string): boolean;
  /** The user's data key, wrapped by the KMS (issue #586); undefined until a KMS made one. */
  dataKey(): string | undefined;
  /** Keeps the wrapped data key; false (nothing written) when one is kept already. */
  keepDataKey(wrapped: string): boolean;
}
