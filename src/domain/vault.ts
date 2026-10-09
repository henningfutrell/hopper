// The vault (issue #558, design.md "The vault"): a user's secrets, set once in the UI and never read back, kept sealed
// in the user's store under the token key. The types every part shares: a secret is only ever its metadata.

/** A vault secret's name: a letter, then letters, digits, `_`, `.`, `-`; at most 64. */
export const VAULT_SECRET_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** The longest value the vault keeps: a key pair, a token, a PEM. */
export const VAULT_VALUE_MAX = 64 * 1024;
/** The longest scope: a line saying what the secret reaches. */
export const VAULT_SCOPE_MAX = 200;
/** The longest reference to where a vault backend keeps a value (issue #585). */
export const VAULT_REFERENCE_MAX = 500;

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
  /**
   * Where the value is kept when not in the hopper (issue #585): a vault backend's instance name and the reference it
   * reads. Absent: the hopper keeps the value itself, sealed.
   */
  backend?: { name: string; reference: string };
  /** When it was last delivered, to which machine, for which job (issue #558, slice 3). */
  lastUsed?: { at: string; machine: string; job: string };
}

/** `GET /api/vault`: never a value. */
export interface VaultView {
  secrets: VaultSecret[];
  /** The templates (issue #558, slice 2), each with what waits for a person. */
  templates: TemplateView[];
  /** The vault backends a secret may be kept in (issue #585): each configured one, and why it cannot run when it cannot. */
  backends: VaultBackendView[];
  /** Why no secret can be stored now (no token key); absent when one can. */
  problem?: string;
}

/**
 * A vault backend (issue #585, design.md "Vault backends"): where a vault secret's value may be kept outside the hopper
 * — HashiCorp Vault, 1Password, Bitwarden. Only where the value is kept changes: the vault still decides who gets it.
 * The hopper reads the value at the moment of use and keeps no copy.
 */
export interface VaultBackend {
  readonly name: string;
  /** Why `reference` is not one this backend reads, or undefined. Its form only: no network, no credential. */
  check(reference: string): string | undefined;
  /** The value `reference` points at, now. Throws, saying why, when it cannot: never with a value in the message. */
  read(reference: string): Promise<string>;
}

/** A configured vault backend (issue #585), as the plugin host gives it the vault: running (`backend`), or why not. */
export interface ConfiguredBackend extends VaultBackendView {
  backend?: VaultBackend;
}

/** A vault backend as the vault shows it (issue #585): its instance name, its plugin, and why it cannot run now. */
export interface VaultBackendView {
  name: string;
  plugin: string;
  /** Why it cannot run now (an unknown plugin, invalid options); absent when it runs. */
  problem?: string;
  /** What it still needs (its token in the runtime); absent when nothing. */
  setup?: string;
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
  savedBy: string;
  savedAt: string;
  /** The last approval: the image and scope a person approved, who and when. Absent: never approved. */
  approval?: { image: string; secrets: string[]; by: string; at: string };
}

/** A template as the vault shows it: what waits for a person, and what its boxes may be given now. */
export interface TemplateView extends Template {
  /** What waits for approval: secrets added since, and whether the image is not the one approved. */
  pending: { secrets: string[]; image: boolean };
  /** The secrets its boxes may be given now: its scope, as far as it was approved, while its image is the approved one. */
  gives: string[];
}

export function templateView(t: Template): TemplateView {
  const approved = t.approval?.secrets ?? [];
  const image = t.approval?.image !== t.image;
  return { ...t, pending: { secrets: t.secrets.filter((s) => !approved.includes(s)), image }, gives: image ? [] : t.secrets.filter((s) => approved.includes(s)) };
}
