// The access model's objects and tuples (issue #559), pure: how a template, a job, an operation profile and an asset
// are named in OpenFGA, the two tuples an approval is, and the relationship path that explains an allow.
import { OPERATIONS, ASSET_KINDS, type Operation, type OperationProfile, type RelationshipTuple, type Asset, type AssetKind } from '../domain/types.ts';

export const templateObject = (template: string): string => `template:${template}`;
export const jobObject = (job: { userId: string; jobId: string }): string => `job:${job.userId}/${job.jobId}`;
export const assetObject = (t: Asset): string => `asset:${t.kind}/${t.name}`;

/** `read/cluster/x`: the operation, then the asset. */
export const profileId = (p: OperationProfile): string => `${p.operation}/${p.asset.kind}/${p.asset.name}`;
export const profileObject = (p: OperationProfile): string => `operation_profile:${profileId(p)}`;

/** The operation profile an id names, or undefined. */
export function profileOf(id: string): OperationProfile | undefined {
  const first = id.indexOf('/');
  const second = id.indexOf('/', first + 1);
  if (first < 0 || second < 0) return undefined;
  const operation = id.slice(0, first);
  const kind = id.slice(first + 1, second);
  const name = id.slice(second + 1);
  if (!(OPERATIONS as readonly string[]).includes(operation) || !(ASSET_KINDS as readonly string[]).includes(kind) || name === '') return undefined;
  return { operation: operation as Operation, asset: { kind: kind as AssetKind, name } };
}

/** The profile grants its operation on its asset; the template is approved for the profile. */
export function approvalTuples(template: string, p: OperationProfile): { grant: RelationshipTuple; approval: RelationshipTuple } {
  const profile = profileObject(p);
  return {
    grant: { subject: profile, relation: `grants_${p.operation}`, object: assetObject(p.asset) },
    approval: { subject: templateObject(template), relation: 'approved_for', object: profile },
  };
}

/** The tuple a job's check adds while it is live: the job is running from its template. */
export const runningTuple = (job: string, template: string): RelationshipTuple => ({ subject: job, relation: 'running', object: templateObject(template) });

const same = (a: RelationshipTuple, b: RelationshipTuple) => a.subject === b.subject && a.relation === b.relation && a.object === b.object;

/**
 * The path from the job to the asset through the approval rows, when the live tuples hold it; undefined when they do
 * not (a model edit allowed it another way): the path is the hopper's reading of its own rows, not OpenFGA's.
 */
export function relationshipPath(live: readonly RelationshipTuple[], job: string, template: string, p: OperationProfile): RelationshipTuple[] | undefined {
  const { grant, approval } = approvalTuples(template, p);
  if (!live.some((t) => same(t, grant)) || !live.some((t) => same(t, approval))) return undefined;
  return [runningTuple(job, template), approval, grant];
}
