// Access (issue #559, design.md "Access: OpenFGA decides each mint"): before the vault (issue #558) mints or renews a
// credential, the hopper asks OpenFGA whether the requester — a job, a machine or a user (issue #581) — reaches a
// template approved for that operation on that asset. The types the model needs: a requester, a template by name, an
// operation, an asset, and the operation profile that is an operation on an asset. The approvals and the model are the
// hopper's, rows in its database, pushed to OpenFGA with the tuples of who is live; every decision is recorded.
import type { TemplateRadius } from './blast-radius.ts';
import type { TrustLevel } from './trust-stamp.ts';
import { backendProblem, type StateBackend } from './state-backend.ts';

/**
 * What a credential lets a job do on its asset. Write and apply are the high blast-radius ones (#542, #544). Observe
 * (issue #2146): read a cluster or a namespace and port-forward to its pods, a bastion's credential; it changes no asset,
 * but a forward reaches every port of a pod, so it is high radius too.
 */
export const OPERATIONS = ['read', 'write', 'sync', 'apply', 'observe'] as const;
export type Operation = (typeof OPERATIONS)[number];

/** The operations that change their asset: only an approved plan mints them (issue #870), and none while infra applies are off. */
export const CHANGE_OPERATIONS = ['write', 'sync', 'apply'] as const satisfies readonly Operation[];
/** Whether the profile changes its asset (a write, sync or apply), so its mint needs a plan. Read and observe do not. */
export const changesAsset = (p: { operation: string }): boolean => (CHANGE_OPERATIONS as readonly string[]).includes(p.operation);

/** What a credential is for: a cluster, a namespace (`<cluster>/<namespace>`), an Argo CD app, a Terraform workspace, an AWS account, an AWS role (`<account>/<role>`). */
export const ASSET_KINDS = ['cluster', 'namespace', 'argocd-app', 'terraform-workspace', 'aws-account', 'aws-role'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export interface Asset { kind: AssetKind; name: string }

/**
 * An operation on an asset: what an approval lets a template's jobs do (`read/cluster/x`). `backend` (issue #715): a
 * terraform workspace's state backend, which the read-only check probes; it is no part of what is approved.
 */
export interface OperationProfile { operation: Operation; asset: Asset; backend?: StateBackend }

/** A template's name: lowercase letters, digits, `.`, `_` and `-`. The vault (issue #558) registers templates; here a name is enough. */
export const TEMPLATE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** An asset's name: letters, digits and `. _ / + = , -`. OpenFGA takes no `:`, `@`, `#` or space in an id, so an AWS role is `<account>/<role>`, not its ARN. */
export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._/+=,-]{0,199}$/;

/** Why an operation profile is not one the model can hold, or undefined. */
export function profileProblem(p: { operation: string; asset: { kind: string; name: string }; backend?: StateBackend }): string | undefined {
  if (!(OPERATIONS as readonly string[]).includes(p.operation)) return `operation ${JSON.stringify(p.operation)} is not one of ${OPERATIONS.join(', ')}`;
  if (!(ASSET_KINDS as readonly string[]).includes(p.asset.kind)) return `asset kind ${JSON.stringify(p.asset.kind)} is not one of ${ASSET_KINDS.join(', ')}`;
  if (!ASSET_NAME.test(p.asset.name)) return `asset name ${JSON.stringify(p.asset.name)} has a character an asset name may not have (letters, digits and . _ / + = , -; an AWS role as <account>/<role>)`;
  if (p.backend && p.asset.kind !== 'terraform-workspace') return `${p.asset.kind} ${p.asset.name}: only a terraform-workspace need has a state backend`;
  return p.backend ? backendProblem(p.backend) : undefined;
}

/** One relationship, as OpenFGA keeps it: `subject` is `relation` of `object` (OpenFGA's user, relation, object). */
export interface RelationshipTuple { subject: string; relation: string; object: string }

/** Who asks in an access check (issue #581): a job, a machine (a box) or a user, each of one user. */
export type Requester =
  | { kind: 'job'; userId: string; jobId: string }
  | { kind: 'machine'; userId: string; machine: string }
  | { kind: 'user'; userId: string };

/** A request for a credential: who asks, and the operation profile it asks for. The template comes from the requester's relations, never from the request. */
export interface MintRequest {
  requester: Requester;
  operation: Operation;
  asset: Asset;
}

/**
 * A read-only check's ask for a credential (issue #797): the check box `check` runs as `template` and runs no job, so
 * Access is asked as for a live job of that template (as a trial is), and the decision is recorded as the check's.
 */
export interface CheckMintRequest { template: string; check: string; operation: Operation; asset: Asset }

/**
 * Who is live now, of one user, as the hopper writes it to OpenFGA: each live job with the machine it runs on and the
 * level its stamp verifies at (issue #655, part 15; none: no stamp verifies, or no stamp key), and each box with the
 * template it joined as.
 */
export interface LiveRequesters {
  userId: string;
  jobs: { jobId: string; machine?: string; trust?: TrustLevel }[];
  boxes: { machine: string; template: string }[];
}

/** One row of the permission matrix (#559): a requester, the template it runs as now, and each operation profile it reaches, with the path. */
export interface RequesterRow {
  requester: Requester;
  /** A job's or a box's template now; a job's machine. */
  template?: string;
  machine?: string;
  /** A job's trust level, as OpenFGA holds it (issue #655, part 15). */
  trust?: TrustLevel;
  grants: { profile: OperationProfile; path: RelationshipTuple[] }[];
}

/** The answer to a mint request: allowed or not, why, and the relationship path that allowed it when the hopper can name it. */
export interface MintDecision {
  id: string;
  at: string;
  allowed: boolean;
  reason: string;
  /** From the requester to the asset, when the hopper's rows explain the allow; absent on a deny, or when a model edit allowed it another way. */
  path?: RelationshipTuple[];
  /** The OpenFGA authorization model asked. */
  modelId?: string;
}

/**
 * A recorded decision: the request with its answer, and the template the requester ran as. A check tried from Settings →
 * Access is a `trial`, by whom; a read-only check's mint (issue #797) is a `check`, by its check box.
 */
export interface AccessDecisionRecord extends MintDecision {
  requester?: Requester;
  /** `level`: the trust level the trial's made-up job was told (issue #655, part 15); none: owner. */
  trial?: { by: string; level?: TrustLevel };
  check?: { box: string };
  template?: string;
  operation: Operation;
  asset: Asset;
}

/** Whether OpenFGA can be asked: not set up, connected (everything pushed), or not reachable (or it refused what the hopper pushed). */
export type AccessState = 'not-configured' | 'connected' | 'unreachable';

export interface AccessStatus {
  state: AccessState;
  /** Why it is not connected, in words. */
  why?: string;
  /** When everything was last pushed. */
  syncedAt?: string;
  storeId?: string;
  modelId?: string;
}

/** A template approved for an operation profile: who approved it, when, and the chain from the template to the asset. */
export interface Approval {
  /** The approval's row: Revoke names it. */
  id: number;
  template: string;
  profile: OperationProfile;
  approvedBy: string;
  approvedAt: string;
  chain: RelationshipTuple[];
}

export interface RevokedApproval extends Approval { revokedBy: string; revokedAt: string }

export interface AccessModelView {
  /** Changes with each saved model: a model edit names the version it read. */
  version: number;
  dsl: string;
  writtenBy: string;
  writtenAt: string;
}

/** GET /api/access: Settings → Access. */
export interface AccessView {
  status: AccessStatus;
  model: AccessModelView;
  /** Each template with an approval or a vault template's name, its approvals and its blast radius (issue #584). */
  templates: { template: string; approvals: Approval[]; radius: TemplateRadius }[];
  /** The newest revoked approvals. */
  revoked: RevokedApproval[];
  /** Each requester now (issue #581) — every user, each live job, each box — and what it reaches: the permission matrix's rows. */
  requesters: RequesterRow[];
  /** The newest decisions, newest first. */
  decisions: AccessDecisionRecord[];
  /** Each operation profile with a minimum trust (issue #655, part 15): no job below it is its requester. */
  minTrust: MinTrust[];
}

/** An operation profile's minimum trust (issue #655, part 15), who set it and when. */
export interface MinTrust { profile: OperationProfile; level: TrustLevel; setBy: string; setAt: string }

/** POST /ui/api/access: approve (what the vault's gate, issue #558, writes), revoke, try a check, or save the model. */
export type AccessEdit =
  | { action: 'approve'; template: string; operation: Operation; asset: Asset }
  | { action: 'revoke'; approval: number }
  | { action: 'check'; template: string; operation: Operation; asset: Asset; level?: TrustLevel }
  | { action: 'min-trust'; operation: Operation; asset: Asset; level: TrustLevel | null }
  | { action: 'model'; dsl: string; version: number };

/**
 * What the vault's gate (issue #584) reads and writes of access for a template: the operation profiles it is approved
 * for now, an approval, and a revoke. Access is the one record of which profiles are approved.
 */
export interface TemplateApprovals {
  /** Each template's approved profiles, by template name, from one read of access (issue #2367): a template with none is absent. */
  approvedProfiles(): ReadonlyMap<string, OperationProfile[]>;
  approve(template: string, profile: OperationProfile, by: string): Promise<void>;
  /** Revokes the template's live approval of the profile; nothing when there is none. */
  revokeProfile(template: string, profile: OperationProfile, by: string): Promise<void>;
}

/**
 * An ask about a secret in the vault's system scope (issue #657): `change` — set or remove it —, or `read` it. `owner`:
 * the user it is kept for; `admin`: the requester signed in as an admin.
 */
export interface SystemSecretAsk {
  requester: Requester;
  owner: string;
  name: string;
  action: 'change' | 'read';
  admin?: boolean;
}

/**
 * An ask about a shared secret (issue #718): `read` it, for a job of `userId`, or `change` it — set or remove — as
 * `userId`, `admin` when the session is the hopper's admin's. `readers`: the users it is shared with; absent, every user.
 */
export interface SharedSecretAsk {
  userId: string;
  name: string;
  action: 'change' | 'read';
  admin?: boolean;
  readers?: readonly string[];
}

/**
 * An ask about a use of an API token (issue #718): whether the user's token `tokenId` may act with `role` — read
 * (`viewer`), act as an operator, or as an admin — for the request at hand. The token's owner is told at each ask.
 */
export interface ApiTokenAsk { userId: string; tokenId: string; role: 'viewer' | 'operator' | 'admin' }
/** An ask about a box action with an API token (issue #795): `box` — whether it is a box token — is told at each ask. */
export interface ApiTokenBoxAsk { userId: string; tokenId: string; box: boolean }

/**
 * An ask about a relay connection (issue #2146): the job whose bastion it is, its template, the target, and whether a
 * person approved the target with the template (`approved`, from the template), told at each ask.
 */
export interface RelayAsk { userId: string; jobId: string; template: string; target: string; approved: boolean }

/** What the vault reads of access (issue #580): the gate's approvals, and the decision it asks before every mint and renewal. */
export interface VaultAccess extends TemplateApprovals {
  decideMint(request: MintRequest): Promise<MintDecision>;
  /** Whether a read-only check box of the template gets the credential (issue #797): asked before each of its mints; recorded. */
  decideCheckMint(request: CheckMintRequest): Promise<MintDecision>;
  /** Whether a requester may change or read a system secret (issue #657): OpenFGA's answer, asked each time; a deny when it cannot be had. */
  decideSystemSecret(ask: SystemSecretAsk): Promise<AccessAnswer>;
  /** Whether a user may read or change a shared secret (issue #718): OpenFGA's answer, the readers told at each ask; a deny when it cannot be had. */
  decideSharedSecret(ask: SharedSecretAsk): Promise<AccessAnswer>;
  /** Whether a job may relay to a target of its bastion (issue #2146): OpenFGA's `bastion#can_relay`, asked at each connection. Absent: no relay. */
  decideRelay?(ask: RelayAsk): Promise<AccessAnswer>;
  /** Each operation profile's minimum trust (issue #655 part 15): what a job's stamp may ask for at gate 2 (part 16). Absent: none. */
  minTrusts?(): MinTrust[];
}

/** What intake asks of access (issue #652): whether a GitHub login may start a user's jobs, the user's trusted actors told. */
export interface IntakeAccess {
  decideIntakeActor(userId: string, login: string, actors: readonly string[]): Promise<AccessAnswer>;
  /** Whether a GitLab user (by the GitLab's URL and user id) may start a user's jobs (issue #1448), the user's trusted GitLab actors told. */
  decideGitLabIntakeActor(userId: string, actor: GitLabActorRef, actors: readonly GitLabActorRef[]): Promise<AccessAnswer>;
}

/** A GitLab user as Access names it (issue #1448): the GitLab's URL and the user's id there. */
export interface GitLabActorRef { baseUrl: string; userId: number }

/** Access's answer to one check. `unavailable`: OpenFGA could not be asked (not set up, not reached), so it is a deny by outage, not a refusal (issue #696). */
export interface AccessAnswer { allowed: boolean; reason: string; unavailable?: true }

/** What a change that needs Access says when OpenFGA cannot be asked (issue #696): a 503, never a 401 or 403 that reads as signed out. */
export const ACCESS_UNAVAILABLE = 'access checks are unavailable: OpenFGA is not reachable';

// ---- Ports ---------------------------------------------------------------------------

/**
 * OpenFGA at its seam (`src/authz/openfga.ts`). A call that fails throws: an error with `refused: true` is OpenFGA
 * answering no (an invalid model or tuple), any other is OpenFGA not reached.
 */
export interface AuthorizationServer {
  /** The store `id` names, or a new one named `name` when `id` is absent or the server holds no such store. */
  store(id: string | undefined, name: string): Promise<string>;
  /** A new authorization model (OpenFGA's JSON); its id. */
  writeModel(storeId: string, model: object): Promise<string>;
  /** Every tuple the store holds. */
  tuples(storeId: string): Promise<RelationshipTuple[]>;
  write(storeId: string, modelId: string, change: { writes: RelationshipTuple[]; deletes: RelationshipTuple[] }): Promise<void>;
  /** Whether `tuple` holds under the model, with `contextual` tuples added for this check only. */
  check(storeId: string, modelId: string, tuple: RelationshipTuple, contextual: RelationshipTuple[]): Promise<boolean>;
}

/** OpenFGA answered no: the error an AuthorizationServer throws for a model or tuple it refuses. */
export function authorizationServerRefusal(message: string): Error & { refused: true } {
  return Object.assign(new Error(message), { refused: true as const });
}

export const isRefusal = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { refused?: unknown }).refused === true;

export interface StoredAccessModel { seq: number; dsl: string; writtenBy: string; writtenAt: string }
export interface StoredTuple extends RelationshipTuple { seq: number; writtenBy: string; writtenAt: string; revokedBy?: string; revokedAt?: string }

/** The access rows (instance schema): the models, the tuples (live and revoked), the decisions, and what was pushed where. */
export interface AccessRepository {
  /** The newest model, or undefined while none was saved. */
  model(): StoredAccessModel | undefined;
  addModel(dsl: string, by: string, at: string): StoredAccessModel;
  /** Every live tuple, oldest first. */
  liveTuples(): StoredTuple[];
  /** The live tuple, or a new one. */
  addTuple(t: RelationshipTuple, by: string, at: string): StoredTuple;
  /** The tuple revoked, or undefined when no live tuple has this row. */
  revokeTuple(seq: number, by: string, at: string): StoredTuple | undefined;
  /** The newest revoked tuples of `relation`, newest first. */
  revoked(relation: string, limit: number): StoredTuple[];
  /** What the hopper keeps of OpenFGA: the store id, and the model pushed there. */
  state(key: string): string | undefined;
  setState(key: string, value: string): void;
  recordDecision(d: AccessDecisionRecord): void;
  /** The newest decisions, newest first. */
  decisions(limit: number): AccessDecisionRecord[];
}
