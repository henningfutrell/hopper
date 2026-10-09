// Access (issue #559, design.md "Access: OpenFGA decides each mint"): before the vault (issue #558) mints or renews a
// credential, the hopper asks OpenFGA whether the requester — a job, a machine or a user (issue #581) — reaches a
// template approved for that operation on that asset. The types the model needs: a requester, a template by name, an
// operation, an asset, and the operation profile that is an operation on an asset. The approvals and the model are the
// hopper's, rows in its database, pushed to OpenFGA with the tuples of who is live; every decision is recorded.
import type { TemplateRadius } from './blast-radius.ts';

/** What a credential lets a job do on its asset. Write and apply are the high blast-radius ones (#542, #544). */
export const OPERATIONS = ['read', 'write', 'sync', 'apply'] as const;
export type Operation = (typeof OPERATIONS)[number];

/** What a credential is for: a cluster, a namespace (`<cluster>/<namespace>`), an Argo CD app, a Terraform workspace, an AWS account, an AWS role (`<account>/<role>`). */
export const ASSET_KINDS = ['cluster', 'namespace', 'argocd-app', 'terraform-workspace', 'aws-account', 'aws-role'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export interface Asset { kind: AssetKind; name: string }

/** An operation on an asset: what an approval lets a template's jobs do (`read/cluster/x`). */
export interface OperationProfile { operation: Operation; asset: Asset }

/** A template's name: lowercase letters, digits, `.`, `_` and `-`. The vault (issue #558) registers templates; here a name is enough. */
export const TEMPLATE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** An asset's name: letters, digits and `. _ / + = , -`. OpenFGA takes no `:`, `@`, `#` or space in an id, so an AWS role is `<account>/<role>`, not its ARN. */
export const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._/+=,-]{0,199}$/;

/** Why an operation profile is not one the model can hold, or undefined. */
export function profileProblem(p: { operation: string; asset: { kind: string; name: string } }): string | undefined {
  if (!(OPERATIONS as readonly string[]).includes(p.operation)) return `operation ${JSON.stringify(p.operation)} is not one of ${OPERATIONS.join(', ')}`;
  if (!(ASSET_KINDS as readonly string[]).includes(p.asset.kind)) return `asset kind ${JSON.stringify(p.asset.kind)} is not one of ${ASSET_KINDS.join(', ')}`;
  if (!ASSET_NAME.test(p.asset.name)) return `asset name ${JSON.stringify(p.asset.name)} has a character an asset name may not have (letters, digits and . _ / + = , -; an AWS role as <account>/<role>)`;
  return undefined;
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

/** Who is live now, of one user, as the hopper writes it to OpenFGA: each live job with the machine it runs on, and each box with the template it joined as. */
export interface LiveRequesters {
  userId: string;
  jobs: { jobId: string; machine?: string }[];
  boxes: { machine: string; template: string }[];
}

/** One row of the permission matrix (#559): a requester, the template it runs as now, and each operation profile it reaches, with the path. */
export interface RequesterRow {
  requester: Requester;
  /** A job's or a box's template now; a job's machine. */
  template?: string;
  machine?: string;
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

/** A recorded decision: the request with its answer, and the template the requester ran as. A check tried from Settings → Access is a `trial`, by whom. */
export interface AccessDecisionRecord extends MintDecision {
  requester?: Requester;
  trial?: { by: string };
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
}

/** POST /ui/api/access: approve (what the vault's gate, issue #558, writes), revoke, try a check, or save the model. */
export type AccessEdit =
  | { action: 'approve'; template: string; operation: Operation; asset: Asset }
  | { action: 'revoke'; approval: number }
  | { action: 'check'; template: string; operation: Operation; asset: Asset }
  | { action: 'model'; dsl: string; version: number };

/**
 * What the vault's gate (issue #584) reads and writes of access for a template: the operation profiles it is approved
 * for now, an approval, and a revoke. Access is the one record of which profiles are approved.
 */
export interface TemplateApprovals {
  approvedProfiles(template: string): OperationProfile[];
  approve(template: string, profile: OperationProfile, by: string): Promise<void>;
  /** Revokes the template's live approval of the profile; nothing when there is none. */
  revokeProfile(template: string, profile: OperationProfile, by: string): Promise<void>;
}

/** What the vault reads of access (issue #580): the gate's approvals, and the decision it asks before every mint and renewal. */
export interface VaultAccess extends TemplateApprovals {
  decideMint(request: MintRequest): Promise<MintDecision>;
}

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
