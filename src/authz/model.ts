// The access model (issue #559): OpenFGA's DSL, kept in the hopper's database and edited in Settings → Access. The
// default says a job may do an operation on an asset when its template is approved for the operation profile that
// grants it. A job's link to its template is not a row: the hopper tells it with each check, and only while the job
// is live. An edit may change how a relation is reached, never drop one the hopper writes or asks (`modelGaps`).
import { transformer } from '@openfga/syntax-transformer';
import { OPERATIONS } from '../domain/types.ts';

export const DEFAULT_ACCESS_MODEL = `model
  schema 1.1

# One run of a job. The hopper tells which template it runs from with each check, while the job is live.
type job

# A kind of machine a job runs on (the vault's templates, issue #558).
type template
  relations
    define running: [job]

# An operation on an asset, as read/cluster/x. A template approved for it lets its running jobs do the operation.
type operation_profile
  relations
    define approved_for: [template]
    define running_job: running from approved_for

# What a credential is for: a cluster, a namespace, an Argo CD app, a Terraform workspace, an AWS account or role.
type asset
  relations
    define grants_read: [operation_profile]
    define grants_write: [operation_profile]
    define grants_sync: [operation_profile]
    define grants_apply: [operation_profile]
    define can_read: running_job from grants_read
    define can_write: running_job from grants_write
    define can_sync: running_job from grants_sync
    define can_apply: running_job from grants_apply
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
  ['template', 'running', 'job'],
  ['operation_profile', 'approved_for', 'template'],
  ...OPERATIONS.map((op) => ['asset', `grants_${op}`, 'operation_profile'] as [string, string, string]),
];
const ASKED: readonly [type: string, relation: string][] = OPERATIONS.map((op) => ['asset', `can_${op}`]);

/** Each relation the hopper needs that the model lacks (`type#relation`) or no longer lets it write (`… accepts type`); empty: none. */
export function modelGaps(model: ModelJson): string[] {
  const def = (type: string) => model.type_definitions.find((t) => t.type === type);
  const gaps: string[] = [];
  if (!def('job')) gaps.push('type job');
  for (const [type, relation, accepts] of WRITTEN) {
    const t = def(type);
    if (!t?.relations?.[relation]) { gaps.push(`${type}#${relation}`); continue; }
    const direct = t.metadata?.relations?.[relation]?.directly_related_user_types ?? [];
    if (!direct.some((d) => d.type === accepts)) gaps.push(`${type}#${relation} accepts ${accepts}`);
  }
  for (const [type, relation] of ASKED) if (!def(type)?.relations?.[relation]) gaps.push(`${type}#${relation}`);
  return gaps;
}
