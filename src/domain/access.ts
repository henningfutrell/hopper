// Access (issue #559, design.md "Access: OpenFGA decides each mint"): before the vault (issue #558) mints or renews a
// credential for a job, the hopper asks OpenFGA whether the job's template is approved for that operation on that
// asset. The types the model needs, kept minimal for the vault to adopt or extend: a template by name, an operation,
// an asset, and the operation profile that is an operation on an asset. The approvals and the model are the hopper's,
// rows in its database, pushed to OpenFGA; every decision is recorded.

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

/** One relationship, as OpenFGA keeps it: `subject` is `relation` of `object` (OpenFGA's user, relation, object). */
export interface RelationshipTuple { subject: string; relation: string; object: string }

/** A job's request for a credential: which job, its template, and the operation profile it asks for. */
export interface MintRequest {
  job: { userId: string; jobId: string };
  template: string;
  operation: Operation;
  asset: Asset;
}

/** The answer to a mint request: allowed or not, why, and the relationship path that allowed it when the hopper can name it. */
export interface MintDecision {
  id: string;
  at: string;
  allowed: boolean;
  reason: string;
  /** From the job to the asset, when the approval rows explain the allow; absent on a deny, or when a model edit allowed it another way. */
  path?: RelationshipTuple[];
  /** The OpenFGA authorization model asked. */
  modelId?: string;
}

/** A recorded decision: the request with its answer. A check tried from Settings → Access is a `trial`, by whom. */
export interface AccessDecisionRecord extends MintDecision {
  job?: { userId: string; jobId: string };
  trial?: { by: string };
  template: string;
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
  templates: { template: string; approvals: Approval[] }[];
  /** The newest revoked approvals. */
  revoked: RevokedApproval[];
  /** The newest decisions, newest first. */
  decisions: AccessDecisionRecord[];
}

/** POST /ui/api/access: approve (what the vault's gate, issue #558, writes), revoke, try a check, or save the model. */
export type AccessEdit =
  | { action: 'approve'; template: string; operation: Operation; asset: Asset }
  | { action: 'revoke'; approval: number }
  | { action: 'check'; template: string; operation: Operation; asset: Asset }
  | { action: 'model'; dsl: string; version: number };

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
