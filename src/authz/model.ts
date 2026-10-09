// The access model (issues #559, #581): OpenFGA's DSL, kept in the hopper's database and edited in Settings → Access.
// The default says a requester — a job, a machine or a user — may do an operation on an asset when it reaches a
// template approved for the operation profile that grants it: a user owns a job, the job runs on a machine, the
// machine is an instance of the template. The hopper writes those tuples from who is live, and removes them when a
// job ends or a machine leaves. An edit may change how a relation is reached, never drop one the hopper writes or
// asks (`modelGaps`).
import { transformer } from '@openfga/syntax-transformer';
import { OPERATIONS } from '../domain/types.ts';

export const DEFAULT_ACCESS_MODEL = `model
  schema 1.1

# A person the hopper works for. The hopper writes that a user owns each of their live jobs.
type user

# One run of a job. Its owner, and the machine it runs on, are written while it is live and removed when it is not.
type job
  relations
    define owns: [user]

# A machine jobs run on. The hopper writes each live job that runs on it.
type machine
  relations
    define runs_on: [job]
    define owner: owns from runs_on

# A kind of machine (the vault's templates, issue #558). A box is an instance of the template it joined as, until it
# leaves. A check tried in Settings → Access tells a made-up job running from it, for that check only.
type template
  relations
    define running: [job]
    define instance_of: [machine]
    define requester: running or instance_of or runs_on from instance_of or owner from instance_of

# An operation on an asset, as read/cluster/x. A template approved for it lets its requesters do the operation.
type operation_profile
  relations
    define approved_for: [template]
    define requester: requester from approved_for

# What a credential is for: a cluster, a namespace, an Argo CD app, a Terraform workspace, an AWS account or role.
type asset
  relations
    define grants_read: [operation_profile]
    define grants_write: [operation_profile]
    define grants_sync: [operation_profile]
    define grants_apply: [operation_profile]
    define can_read: requester from grants_read
    define can_write: requester from grants_write
    define can_sync: requester from grants_sync
    define can_apply: requester from grants_apply
`;

interface RelationMetadata { directly_related_user_types?: { type: string }[] }
export interface ModelJson {
  schema_version: string;
  type_definitions: { type: string; relations?: Record<string, unknown>; metadata?: { relations?: Record<string, RelationMetadata> } | null }[];
}

/** The DSL as OpenFGA's JSON; throws, saying where, when it does not parse. */
export function compileAccessModel(dsl: string): ModelJson {
  return transformer.transformDSLToJSONObject(dsl) as unknown as ModelJson;
}

/** What the hopper writes (a relation and the type it accepts) and what it asks. */
const WRITTEN: readonly [type: string, relation: string, accepts: string][] = [
  ['job', 'owns', 'user'],
  ['machine', 'runs_on', 'job'],
  ['template', 'instance_of', 'machine'],
  ['template', 'running', 'job'],
  ['operation_profile', 'approved_for', 'template'],
  ...OPERATIONS.map((op) => ['asset', `grants_${op}`, 'operation_profile'] as [string, string, string]),
];
const ASKED: readonly [type: string, relation: string][] = OPERATIONS.map((op) => ['asset', `can_${op}`]);

/** Each relation the hopper needs that the model lacks (`type#relation`) or no longer lets it write (`… accepts type`); empty: none. */
export function modelGaps(model: ModelJson): string[] {
  const def = (type: string) => model.type_definitions.find((t) => t.type === type);
  const gaps: string[] = [];
  for (const [type, relation, accepts] of WRITTEN) {
    const t = def(type);
    if (!t?.relations?.[relation]) { gaps.push(`${type}#${relation}`); continue; }
    const direct = t.metadata?.relations?.[relation]?.directly_related_user_types ?? [];
    if (!direct.some((d) => d.type === accepts)) gaps.push(`${type}#${relation} accepts ${accepts}`);
  }
  for (const [type, relation] of ASKED) if (!def(type)?.relations?.[relation]) gaps.push(`${type}#${relation}`);
  return gaps;
}
