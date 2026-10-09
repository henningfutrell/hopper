// The vault (issue #558, design.md "The vault"): a user's secrets, set once in the UI and never read back, kept sealed
// in the user's store under the token key. The types every part shares: a secret is only ever its metadata.

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
}

/** `GET /api/vault`: never a value. */
export interface VaultView {
  secrets: VaultSecret[];
  /** The box templates (issue #558, slice 2), each with what waits for a person. */
  templates: BoxTemplateView[];
  /** Why no secret can be stored now (no token key); absent when one can. */
  problem?: string;
}

/** A box template's name: it names its boxes (`hopper-sandbox-<name>`), so letters, digits, `_`, `-`; at most 40. */
export const BOX_TEMPLATE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/**
 * A box template (issue #558): an image and the vault secrets its boxes may ask for — the scope. The scope is the
 * template's alone, never a job's. A person approves it once; what it gives is what was approved, and only while the
 * image is the one approved.
 */
export interface BoxTemplate {
  name: string;
  /** The image its boxes run: a full reference, as `podman run` takes it. */
  image: string;
  /** The scope: vault secret names. */
  secrets: string[];
  savedBy: string;
  savedAt: string;
  /** The last approval: the image and scope a person approved, who and when. Absent: never approved. */
  approval?: { image: string; secrets: string[]; by: string; at: string };
}

/** A box template as the vault shows it: what waits for a person, and what its boxes may be given now. */
export interface BoxTemplateView extends BoxTemplate {
  /** What waits for approval: secrets added since, and whether the image is not the one approved. */
  pending: { secrets: string[]; image: boolean };
  /** The secrets its boxes may be given now: its scope, as far as it was approved, while its image is the approved one. */
  gives: string[];
}

export function templateView(t: BoxTemplate): BoxTemplateView {
  const approved = t.approval?.secrets ?? [];
  const image = t.approval?.image !== t.image;
  return { ...t, pending: { secrets: t.secrets.filter((s) => !approved.includes(s)), image }, gives: image ? [] : t.secrets.filter((s) => approved.includes(s)) };
}
