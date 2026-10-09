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
  /** When it was last delivered, to which machine, for which job (issue #558, slice 3). */
  lastUsed?: { at: string; machine: string; job: string };
  /**
   * What it is for (issue #583): the skill a credential request gave it to, the kind of credential the user gave,
   * and the user's own words for it when that kind is `other`. A job that asks for the domain is told these, never the value.
   */
  skill?: string;
  kind?: string;
  note?: string;
}

/** `GET /api/vault`: never a value. */
export interface VaultView {
  secrets: VaultSecret[];
  /** The templates (issue #558, slice 2), each with what waits for a person. */
  templates: TemplateView[];
  /** The credential requests that wait for a person (issue #583): what jobs on boxes asked for and the vault does not give. */
  requests: CredentialRequest[];
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

/** A note the user gives with a credential: one line, at most this long. */
export const CREDENTIAL_NOTE_MAX = 200;
/** What a job says it needs a credential for: one line, at most this long. */
export const CREDENTIAL_WHY_MAX = 300;

/**
 * A credential request (issue #583, design.md "The dynamic vault"): the credential a skill needs, which jobs on boxes of one template
 * loaded and the vault does not give them yet. One open request per template and skill: a second job asking joins it. A
 * person gives a credential (any kind; the hopper suggests one) or declines. Kept in the hopper's memory only: a job that
 * still waits asks again, and that opens it again.
 */
export interface CredentialRequest {
  id: string;
  /** The skill (`render`), or the job's own name for a service the hopper has no skill for. */
  skill: string;
  title: string;
  /** Whether the hopper has a skill for it; false: the job said what it takes. */
  known: boolean;
  template: string;
  /** The vault secret name the hopper suggests: the skill's name. */
  secret: string;
  /** The kinds of credential the hopper suggests, the first first. The user may give `other`. */
  kinds: { id: string; title: string }[];
  /** How the user gets one, or sets the tool up. */
  setup: string;
  /** The jobs that wait on it, each with where it runs and what it said it needs the credential for. */
  asked: { job: string; machine: string; why?: string; at: string }[];
  /** Vault secrets the user set earlier for the same skill: the user may give one of these. */
  existing: string[];
  createdAt: string;
}
