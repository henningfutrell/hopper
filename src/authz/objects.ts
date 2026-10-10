// The access model's objects and tuples (issues #559, #581), pure: how a requester, a template, an operation profile
// and an asset are named in OpenFGA, the two tuples an approval is, the tuples of who is live, and the relationship path
// that explains an allow.
import {
  OPERATIONS, ASSET_KINDS, type LiveRequesters, type Operation, type OperationProfile, type RelationshipTuple, type Requester, type Asset, type AssetKind,
} from '../domain/types.ts';

export const templateObject = (template: string): string => `template:${template}`;
export const userObject = (userId: string): string => `user:${userId}`;
export const jobObject = (job: { userId: string; jobId: string }): string => `job:${job.userId}/${job.jobId}`;
/** OpenFGA takes no space, `:` or `#` in an id, and a machine's name may hold one: it is escaped. */
export const machineObject = (m: { userId: string; machine: string }): string => `machine:${m.userId}/${encodeURIComponent(m.machine)}`;

export function requesterObject(r: Requester): string {
  if (r.kind === 'job') return jobObject(r);
  if (r.kind === 'machine') return machineObject(r);
  return userObject(r.userId);
}

/** Who is live, as tuples: a user owns each live job, a job runs on its machine, a box is an instance of its template. */
export function requesterTuples(live: readonly LiveRequesters[]): RelationshipTuple[] {
  return live.flatMap(({ userId, jobs, boxes }) => [
    ...jobs.flatMap(({ jobId, machine }) => {
      const job = jobObject({ userId, jobId });
      return [
        { subject: userObject(userId), relation: 'owns', object: job },
        ...(machine === undefined ? [] : [{ subject: job, relation: 'runs_on', object: machineObject({ userId, machine }) }]),
      ];
    }),
    ...boxes.map(({ machine, template }) => ({ subject: machineObject({ userId, machine }), relation: 'instance_of', object: templateObject(template) })),
  ]);
}
/** An artifact (issue #624), a public link to one, and the tuple each live share is: its user or link is a viewer. */
export const artifactObject = (a: { userId: string; id: string }): string => `artifact:${a.userId}/${a.id}`;
export const linkObject = (l: { userId: string; shareId: string }): string => `link:${l.userId}/${l.shareId}`;
export function shareTuples(shares: readonly { ownerId: string; artifactId: string; shareId: string; userId?: string }[]): RelationshipTuple[] {
  return shares.map((s) => ({
    subject: s.userId !== undefined ? userObject(s.userId) : linkObject({ userId: s.ownerId, shareId: s.shareId }),
    relation: 'viewer', object: artifactObject({ userId: s.ownerId, id: s.artifactId }),
  }));
}
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

/** The tuple a check tried in Settings → Access adds for its made-up job: the job is running from the template. */
export const runningTuple = (job: string, template: string): RelationshipTuple => ({ subject: job, relation: 'running', object: templateObject(template) });

const same = (a: RelationshipTuple, b: RelationshipTuple) => a.subject === b.subject && a.relation === b.relation && a.object === b.object;
/** The steps from a requester to its template, as the default model reads them. */
const TOWARD_TEMPLATE = new Set(['owns', 'runs_on', 'instance_of', 'running']);

/**
 * The path from the requester (a job's owner first) to the asset through the tuples given — who is live, and the approval rows —, when they
 * hold one; undefined when they do not (a model edit allowed it another way): the path is the hopper's reading of its
 * own rows, not OpenFGA's.
 */
export function relationshipPath(live: readonly RelationshipTuple[], requester: string, p: OperationProfile): RelationshipTuple[] | undefined {
  const walk = (at: string, seen: Set<string>): RelationshipTuple[] | undefined => {
    if (at.startsWith('template:')) {
      const { grant, approval } = approvalTuples(at.slice('template:'.length), p);
      return live.some((t) => same(t, grant)) && live.some((t) => same(t, approval)) ? [approval, grant] : undefined;
    }
    for (const step of live) {
      if (step.subject !== at || !TOWARD_TEMPLATE.has(step.relation) || seen.has(step.object)) continue;
      const rest = walk(step.object, new Set([...seen, step.object]));
      if (rest) return [step, ...rest];
    }
    return undefined;
  };
  const path = walk(requester, new Set([requester]));
  // A job's path names whose job it is too: its owner, when the hopper wrote one.
  const owner = requester.startsWith('job:') ? live.find((t) => t.relation === 'owns' && t.object === requester) : undefined;
  return path && owner ? [owner, ...path] : path;
}
