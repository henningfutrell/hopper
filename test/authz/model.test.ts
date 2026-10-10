// Issue #559: the access model the hopper keeps and asks OpenFGA with. The default model compiles and has every
// relation the hopper writes or asks; a model edit that drops one is named; an operation profile's id round-trips.
// Issue #581: the requesters — a user owns a job, a job runs on a machine, a machine is an instance of a template — are
// tuples the hopper writes from who is live, and the path from a requester to an asset names each step.
import { describe, expect, it } from 'vitest';
import { artifactGaps, compileAccessModel, DEFAULT_ACCESS_MODEL, modelGaps } from '../../src/authz/model.ts';
import { shareTuples, profileId, profileOf, assetObject, approvalTuples, machineObject, relationshipPath, requesterObject, requesterTuples } from '../../src/authz/objects.ts';

describe('the access model', () => {
  it('compiles the default model with no gap', () => {
    const json = compileAccessModel(DEFAULT_ACCESS_MODEL);
    expect(json.type_definitions.map((t) => t.type).sort()).toEqual(['artifact', 'asset', 'job', 'link', 'machine', 'operation_profile', 'template', 'user']);
    expect(modelGaps(json)).toEqual([]);
    expect(artifactGaps(json)).toEqual([]);
  });

  it('a model edited before artifacts (issue #624) still decides mints: its artifact gaps are apart', () => {
    const before = DEFAULT_ACCESS_MODEL.slice(0, DEFAULT_ACCESS_MODEL.indexOf('\n# A public link to an artifact'));
    const json = compileAccessModel(before);
    expect(modelGaps(json)).toEqual([]);
    expect(artifactGaps(json)).toEqual(['artifact#viewer', 'artifact#viewer', 'artifact#can_view']);
    const noLinks = DEFAULT_ACCESS_MODEL.replace('define viewer: [user, link]', 'define viewer: [user]');
    expect(artifactGaps(compileAccessModel(noLinks))).toEqual(['artifact#viewer accepts link']);
  });

  it('writes each live share of an artifact as a viewer: a user, or a link (issue #624)', () => {
    expect(shareTuples([
      { ownerId: 'admin', artifactId: 'a1', shareId: 's1', userId: 'bob' },
      { ownerId: 'admin', artifactId: 'a1', shareId: 's2' },
    ])).toEqual([
      { subject: 'user:bob', relation: 'viewer', object: 'artifact:admin/a1' },
      { subject: 'link:admin/s2', relation: 'viewer', object: 'artifact:admin/a1' },
    ]);
  });

  it('names each relation a model edit dropped or stopped accepting', () => {
    const noApply = DEFAULT_ACCESS_MODEL.replace(/\n {4}define can_apply: .*\n/, '\n');
    expect(modelGaps(compileAccessModel(noApply))).toEqual(['asset#can_apply']);
    const noJobs = DEFAULT_ACCESS_MODEL.replace('define running: [job]', 'define running: [template]');
    expect(modelGaps(compileAccessModel(noJobs))).toEqual(['template#running accepts job']);
    const noRunsOn = DEFAULT_ACCESS_MODEL.replace(/\n {4}define runs_on: .*\n/, '\n').replace(' or runs_on from instance_of', '').replace('define owner: owns from runs_on', 'define owner: [user]');
    expect(modelGaps(compileAccessModel(noRunsOn))).toEqual(['machine#runs_on']);
    const noInstances = DEFAULT_ACCESS_MODEL.replace('define instance_of: [machine]', 'define instance_of: [job]');
    expect(modelGaps(compileAccessModel(noInstances))).toEqual(['template#instance_of accepts machine']);
  });

  it('says where a model does not parse', () => {
    expect(() => compileAccessModel('model\n  schema 1.1\ntype')).toThrow(/line|syntax|extraneous|mismatched/i);
  });
});

describe('access objects', () => {
  it('names each requester: a user, a job of a user, a machine of a user', () => {
    expect(requesterObject({ kind: 'user', userId: 'admin' })).toBe('user:admin');
    expect(requesterObject({ kind: 'job', userId: 'admin', jobId: 'j1' })).toBe('job:admin/j1');
    expect(requesterObject({ kind: 'machine', userId: 'admin', machine: 'box' })).toBe('machine:admin/box');
    // OpenFGA takes no space, ':' or '#' in an id: a machine's name is escaped.
    expect(machineObject({ userId: 'bob', machine: 'my box#2' })).toBe('machine:bob/my%20box%232');
  });

  it('writes who is live as tuples: a user owns each live job, the job runs on its machine, a box is an instance of its template', () => {
    expect(requesterTuples([
      { userId: 'admin', jobs: [{ jobId: 'j1', machine: 'box' }, { jobId: 'j2' }], boxes: [{ machine: 'box', template: 'kube' }] },
      { userId: 'bob', jobs: [], boxes: [] },
    ])).toEqual([
      { subject: 'user:admin', relation: 'owns', object: 'job:admin/j1' },
      { subject: 'job:admin/j1', relation: 'runs_on', object: 'machine:admin/box' },
      { subject: 'user:admin', relation: 'owns', object: 'job:admin/j2' },
      { subject: 'machine:admin/box', relation: 'instance_of', object: 'template:kube' },
    ]);
  });

  it('reads the path from a requester to an asset: user, job, machine, template, approval, grant', () => {
    const profile = { operation: 'read', asset: { kind: 'cluster', name: 'x' } } as const;
    const { grant, approval } = approvalTuples('kube', profile);
    const live = [...requesterTuples([{ userId: 'admin', jobs: [{ jobId: 'j1', machine: 'box' }], boxes: [{ machine: 'box', template: 'kube' }] }]), grant, approval];
    expect(relationshipPath(live, 'user:admin', profile)).toEqual([
      { subject: 'user:admin', relation: 'owns', object: 'job:admin/j1' },
      { subject: 'job:admin/j1', relation: 'runs_on', object: 'machine:admin/box' },
      { subject: 'machine:admin/box', relation: 'instance_of', object: 'template:kube' },
      approval, grant,
    ]);
    // A job's path starts at its owner: whose job asked.
    expect(relationshipPath(live, 'job:admin/j1', profile)).toEqual(relationshipPath(live, 'user:admin', profile));
    expect(relationshipPath(live, 'machine:admin/box', profile)).toEqual([{ subject: 'machine:admin/box', relation: 'instance_of', object: 'template:kube' }, approval, grant]);
    expect(relationshipPath(live, 'job:admin/j1', { ...profile, operation: 'write' })).toBeUndefined();
    expect(relationshipPath(live, 'user:bob', profile)).toBeUndefined();
  });

  it('names an operation profile by its operation and asset, and reads it back', () => {
    const asset = { kind: 'aws-role', name: '123456789012/read-only' } as const;
    expect(profileId({ operation: 'read', asset })).toBe('read/aws-role/123456789012/read-only');
    expect(profileOf(profileId({ operation: 'read', asset }))).toEqual({ operation: 'read', asset });
    expect(profileOf('nonsense')).toBeUndefined();
    expect(assetObject({ kind: 'namespace', name: 'x/payments' })).toBe('asset:namespace/x/payments');
  });

  it('approves a template with two tuples: the profile grants its operation, the template is approved for the profile', () => {
    expect(approvalTuples('kubectl-diag', { operation: 'sync', asset: { kind: 'argocd-app', name: 'shop' } })).toEqual({
      grant: { subject: 'operation_profile:sync/argocd-app/shop', relation: 'grants_sync', object: 'asset:argocd-app/shop' },
      approval: { subject: 'template:kubectl-diag', relation: 'approved_for', object: 'operation_profile:sync/argocd-app/shop' },
    });
  });
});
