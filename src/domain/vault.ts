// The vault (issue #558, design.md "The vault"): a user's secrets, set once in the UI and never read back, kept sealed
// in the user's store under the master key. The types every part shares: a secret is only ever its metadata.
import type { VaultGrant, VaultGrantAsk } from './vault-grants.ts';
import type { Asset, OperationProfile } from './access.ts';
import type { TemplateRadius } from './blast-radius.ts';
import { checkWait, type ProbeMarks, type ReadOnlyCheck } from './read-only-check.ts';

export * from './read-only-check.ts';
// Infra plans (issue #870) sit beside the vault: an apply's credential is minted only for one.
export type { InfraPlan, PlanApply, PlanApproval, PlanTool, PlanView } from './infra-plans.ts';
export type { PlanCheck, PlanLevel, PlanRisk, PlanSummary, RiskCallout } from './infra-plan-summary.ts';
export type { Mark, OutOfBandChange, OutOfBandMark, OutOfBandView, SignalSource } from './out-of-band.ts';
import type { BoxTool, TemplateLimits } from './sandboxes.ts';

/** A vault secret's name: a letter, then letters, digits, `_`, `.`, `-`; at most 64. */
export const VAULT_SECRET_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** The longest value the vault keeps: a key pair, a token, a PEM. */
export const VAULT_VALUE_MAX = 64 * 1024;
/** The longest scope: a line saying what the secret reaches. */
export const VAULT_SCOPE_MAX = 200;
/** The longest reference to where a vault backend keeps a value (issue #585). */
export const VAULT_REFERENCE_MAX = 500;

/**
 * The vault's system scope (issues #657, #658): the hopper's own secrets — for one user, their TypeSafe API key, their
 * GitHub connection's access and refresh tokens and their webhook subscriptions' signing secrets; for the whole hopper
 * (the instance's vault), its sign-in realms' secrets. Each is a row of a vault's table named `system/<name>` — a name no
 * vault secret can take —, sealed as any other; but it is none of the vault's own secrets: not listed, in no template,
 * never given to a job, a machine or a box, or minted from. Only the hopper opens one, in its own process; one exception, the
 * tunnel's authtoken (issue #880), which the hopper answers to the tunnel service alone ("Remote access").
 */
/** The TypeSafe API key (issue #657), the key a user's artifact content URLs are signed under (issue #673), the GitHub
 * connection's tokens, each webhook's signing secret, each sign-in realm's secret (issue #658) and the tunnel's ngrok
 * authtoken (issue #880). */
export type SystemSecretName =
  | 'typesafe-api-key'
  | 'remote-access.ngrok-authtoken'
  | 'artifact-content-key'
  | `connected-account.${'github'}.${'access-token' | 'refresh-token'}`
  | `webhook.${string}.signing-secret`
  | `sign-in.${string}.${string}`;
const SYSTEM_PREFIX = 'system/';
/** The vault row's name of a system secret. */
export const systemSecretRow = (name: SystemSecretName): string => `${SYSTEM_PREFIX}${name}`;
/** Whether a vault row's name is in the system scope. */
export const isSystemSecret = (name: string): boolean => name.startsWith(SYSTEM_PREFIX);
/** The system secret a vault row holds: its name without `system/`. */
export const systemSecretName = (row: string): SystemSecretName => row.slice(SYSTEM_PREFIX.length) as SystemSecretName;

/**
 * A shared secret (issue #718, design.md "Shared secrets"): a vault secret the hopper's admin shares with the agents of
 * every user, or of the users named, in place of a copy per user. A row of the instance's vault named `shared/<name>`,
 * sealed under the master key. A template names it by that row name; a job on a box of the template gets it only once
 * a person approved that, and Access (`shared_secret#can_read`) allows the job's user. A vault secret is the user's by
 * default: sharing is the admin's choice.
 */
const SHARED_PREFIX = 'shared/';
/** The instance's vault row, and the name a template and a job use, of the shared secret `name`. */
export const sharedSecretRow = (name: string): string => `${SHARED_PREFIX}${name}`;
/** Whether a name is a shared secret's row. */
export const isSharedSecret = (name: string): boolean => name.startsWith(SHARED_PREFIX);
/** The shared secret's own name: its row name without `shared/`. */
export const sharedSecretName = (row: string): string => (isSharedSecret(row) ? row.slice(SHARED_PREFIX.length) : row);

/** A shared secret as every user's vault page shows it: its metadata, never its value. */
export interface SharedSecretView {
  /** Its row name, `shared/<name>`: what a template names. */
  name: string;
  scope?: string;
  /** The users whose agents may read it. Absent: every user's. */
  readers?: string[];
  setBy: string;
  createdAt: string;
  changedBy: string;
  changedAt: string;
}

/** The kinds of system secret, by what the hopper keeps them for. */
export type SystemSecretKind = 'typesafe' | 'artifact' | 'connected-account' | 'webhook' | 'sign-in' | 'remote-access';
export const systemSecretKind = (name: string): SystemSecretKind =>
  name.startsWith('connected-account.') ? 'connected-account' : name.startsWith('webhook.') ? 'webhook' : name.startsWith('sign-in.') ? 'sign-in'
    : name.startsWith('remote-access.') ? 'remote-access' : name === 'artifact-content-key' ? 'artifact' : 'typesafe';

/**
 * Why a system secret may not be kept in a vault backend (issue #658, requirement 6), or undefined when it may. The
 * backends only read: a secret the hopper writes itself (the GitHub connection's tokens at each renewal, the artifact
 * key it makes) stays in the hopper. The backends are a user's plugins: the whole hopper's (the sign-in realms') stays in
 * the hopper too. What may: the TypeSafe API key and a webhook's signing secret, each a value a person gives.
 */
export function systemBackendRefusal(name: string): string | undefined {
  if (name === 'typesafe-api-key' || /^webhook\.[^.]+\.signing-secret$/.test(name)) return undefined;
  const kind = systemSecretKind(name);
  if (kind === 'typesafe' || kind === 'webhook') return `${name} is no system secret`;
  const why = kind === 'sign-in' || kind === 'remote-access' ? 'it is the whole hopper\'s, and a vault backend is one user\'s plugin' : 'the hopper writes it itself, and a vault backend only reads';
  return `${name} stays in the hopper: ${why}`;
}

/** A system secret as Settings → Vault shows it (issue #658): never its value. */
export interface SystemSecretView {
  name: string;
  kind: SystemSecretKind;
  /** `user`: kept for this user; `instance`: for the whole hopper (the sign-in realms). */
  scope: 'user' | 'instance';
  /** The last 4 characters, kept when it was set; absent for one set before issue #658. */
  last4?: string;
  setBy: string;
  setAt: string;
  /** Why it cannot be opened now (the start check): the key it was sealed under is missing, or its backend cannot read it. */
  problem?: string;
  /** Where a vault backend keeps it (issue #658, requirement 6): the hopper holds its value in memory only. Absent: in the hopper, sealed. */
  backend?: { name: string; reference: string };
}

/** One entry of the system scope's audit trail (issue #658): an event naming the secret, never its value. */
export interface SystemSecretAudit {
  seq: number;
  at: string;
  type: string;
  name: string;
  by?: string;
  detail?: string;
}

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
  /**
   * A **minting credential** (issue #580): the AWS account or Kubernetes cluster the hopper mints short-lived
   * credentials for from it. Never delivered and never in a template's scope. Absent: a plain secret.
   */
  mints?: Asset;
  /** When it was last delivered, to which machine, for which job (issue #558, slice 3); for a minting credential, when it last minted. */
  lastUsed?: { at: string; machine: string; job: string };
  /** A system secret's last 4 characters (issue #658), kept when it is set: what its page shows. */
  last4?: string;
  /**
   * What it is for (issue #583): the skill a credential request gave it to, the kind of credential the user gave,
   * and the user's own words for it when that kind is `other`. A job that asks for the domain is told these, never the value.
   */
  skill?: string;
  kind?: string;
  note?: string;
  /** A shared secret's readers (issue #718): the users whose agents may read it. Absent: every user's. */
  readers?: string[];
}

/** `GET /api/vault`: never a value. */
export interface VaultView {
  secrets: VaultSecret[];
  /** The templates (issue #558, slice 2), each with what waits for a person. */
  templates: TemplateView[];
  /** The vault backends a secret may be kept in (issue #585): each configured one, and why it cannot run when it cannot. */
  backends: VaultBackendView[];
  /** The credential requests that wait for a person (issue #583): what jobs on boxes asked for and the vault does not give. Absent: none. */
  requests?: CredentialRequest[];
  /** Why no secret can be stored now (no master key); absent when one can. */
  problem?: string;
  /** The hopper's own secrets (issue #658): the system scope's metadata and its audit trail, newest first. */
  system?: { secrets: SystemSecretView[]; audit: SystemSecretAudit[] };
  /** The shared secrets (issue #718): what the hopper's admin shares with agents, for a template to name. Never a value. */
  shared?: SharedSecretView[];
  /** The read policy (issue #716): the assets the hopper approves read on with no person, for a template a job asks for. */
  readPolicy?: string[];
  /** Jobs on boxes that asked the vault with no vault grant (issue #652): a person grants them the vault, or not. */
  grantAsks?: VaultGrantAsk[];
  /** The vault grants (issue #652): the items whose jobs may use the vault's helper, who granted each, and when. */
  grants?: VaultGrant[];
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
  /**
   * The operation profiles its boxes may ask for (issue #584): approved in access, a read profile with the template, a
   * write, sync or apply profile only by its own explicit approval. Absent on a template saved before: none.
   */
  profiles?: OperationProfile[];
  /**
   * What a launch of it may ask for (issue #708): the defaults and maximums of its boxes' resources and time limit, and
   * whether a box's home volume stays when it goes. Absent: the hopper's defaults (src/sandbox/params.ts). Not part of
   * its approval: limits narrow what a box may use, they give it nothing.
   */
  limits?: TemplateLimits;
  /**
   * The tools the hopper adds to its image for its boxes (issue #716; src/sandbox/tools.ts). Part of what its boxes run,
   * so approved with its image: a change waits for a person as a new image does. Absent: none.
   */
  tools?: BoxTool[];
  /**
   * A template a job asked for with read needs only (issue #716, item 4): it takes no box and no job until the read-only
   * check of its current version passed. Kept through every save. Absent: no check.
   */
  readOnly?: true;
  /**
   * The job that asked for it (issue #715): the read-only check's report is an artifact of that job. Kept through every
   * save. Absent: a person or an API caller asked for it, or it was saved before.
   */
  askedBy?: string;
  /**
   * The agent credential (issue #708, part 10; src/domain/agent-credential.ts): one of its secrets, a Claude token, that
   * a box of it starts with, signed in, when its launch's scope holds it. Given only as far as its secrets are approved.
   */
  agentCredential?: string;
  /**
   * A person's marks on its read probes (issue #916): a probe marked `expect-denied` passes only when its read is refused,
   * one marked `skip` is not run. Set only by a person's save; kept through every other save. Absent: none.
   */
  probeMarks?: ProbeMarks;
  /** The last read-only check, of the version it names (src/domain/read-only-check.ts). A save makes it stale. */
  check?: ReadOnlyCheck;
  savedBy: string;
  savedAt: string;
  /** The last approval: the image (and its tools) and scope a person approved, who and when. Absent: never approved. */
  approval?: { image: string; tools?: BoxTool[]; secrets: string[]; by: string; at: string };
}

/** Whether the template runs what was approved: the image, with the same tools (issue #716). False when never approved. */
export function imageApproved(t: Template): boolean {
  const a = t.approval;
  if (!a || a.image !== t.image) return false;
  const was = a.tools ?? [], now = t.tools ?? [];
  return was.length === now.length && was.every((x) => now.includes(x));
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

/**
 * The template a request makes, shown before it is made (issue #708, part 9: the template request on Settings → Vault): what a
 * request with these needs saves now, and who approves it. `exists`: a template of that name is there already, with the
 * same needs (a request makes no second one) or changed by a person (a request is refused).
 */
export interface TemplatePreview {
  template: string; image: string; tools: string[]; needs: string[]; readOnly: boolean;
  approvedBy: 'the read policy' | 'a person'; waits: string[]; exists?: 'same' | 'changed';
}

const sameProfile = (a: OperationProfile, b: OperationProfile): boolean => a.operation === b.operation && a.asset.kind === b.asset.kind && a.asset.name === b.asset.name;

/** The secrets a template's boxes may be given now: its scope, as far as it was approved, while its image is the approved one. */
export function givesOf(t: Template): string[] {
  const approved = t.approval?.secrets ?? [];
  return !imageApproved(t) ? [] : t.secrets.filter((s) => approved.includes(s));
}

/**
 * Why a box of the template `name` takes no new job (issue #602), or undefined when the template is approved: saved, and
 * approved with the image it names now, and (issue #716) its read-only check passed when it needs one. A scope widened
 * since keeps its boxes working on what was approved.
 */
export function approvalWait(name: string, t: Template | undefined): string | undefined {
  const wait = 'waiting for template approval';
  if (!t) return `${wait}: no template ${name} is saved`;
  if (!t.approval) return `${wait}: ${name} is not approved`;
  if (!imageApproved(t)) return `${wait}: the image of ${name} changed since it was approved`;
  return checkWait(t);
}

/** The template's view, with the profiles access approves it for (`approvedProfiles`) and its rating. */
export function templateView(t: Template, approvedProfiles: readonly OperationProfile[], radius: TemplateRadius): TemplateView {
  const approved = t.approval?.secrets ?? [];
  const image = !imageApproved(t);
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
  /** Keeps a new secret, its value already sealed for its id (null: kept in a vault backend, issue #585). False when the name is taken. */
  add(secret: VaultSecret, sealed: string | null): boolean;
  /** Its value, sealed again or replaced, and its metadata; false when there is no such secret. */
  replace(secret: VaultSecret, sealed: string | null): boolean;
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
  /** The skill (`kube-diagnostics`), or the job's own name for a service the hopper has no skill for (`example-api`). */
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
