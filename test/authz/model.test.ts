// Issue #559: the access model the hopper keeps and asks OpenFGA with. The default model compiles and has every
// relation the hopper writes or asks; a model edit that drops one is named; an operation profile's id round-trips.
import { describe, expect, it } from 'vitest';
import { compileAccessModel, DEFAULT_ACCESS_MODEL, modelGaps } from '../../src/authz/model.ts';
import { profileId, profileOf, targetObject, approvalTuples } from '../../src/authz/objects.ts';

describe('the access model', () => {
  it('compiles the default model with no gap', () => {
    const json = compileAccessModel(DEFAULT_ACCESS_MODEL);
    expect(json.type_definitions.map((t) => t.type).sort()).toEqual(['job', 'operation_profile', 'target', 'template']);
    expect(modelGaps(json)).toEqual([]);
  });

  it('names each relation a model edit dropped or stopped accepting', () => {
    const noApply = DEFAULT_ACCESS_MODEL.replace(/\n {4}define can_apply: .*\n/, '\n');
    expect(modelGaps(compileAccessModel(noApply))).toEqual(['target#can_apply']);
    const noJobs = DEFAULT_ACCESS_MODEL.replace('define running: [job]', 'define running: [template]');
    expect(modelGaps(compileAccessModel(noJobs))).toEqual(['template#running accepts job']);
  });

  it('says where a model does not parse', () => {
    expect(() => compileAccessModel('model\n  schema 1.1\ntype')).toThrow(/line|syntax|extraneous|mismatched/i);
  });
});

describe('access objects', () => {
  it('names an operation profile by its operation and target, and reads it back', () => {
    const target = { kind: 'aws-role', name: '123456789012/read-only' } as const;
    expect(profileId({ operation: 'read', target })).toBe('read/aws-role/123456789012/read-only');
    expect(profileOf(profileId({ operation: 'read', target }))).toEqual({ operation: 'read', target });
    expect(profileOf('nonsense')).toBeUndefined();
    expect(targetObject({ kind: 'namespace', name: 'x/payments' })).toBe('target:namespace/x/payments');
  });

  it('approves a template with two tuples: the profile grants its operation, the template is approved for the profile', () => {
    expect(approvalTuples('kubectl-diag', { operation: 'sync', target: { kind: 'argocd-app', name: 'shop' } })).toEqual({
      grant: { subject: 'operation_profile:sync/argocd-app/shop', relation: 'grants_sync', object: 'target:argocd-app/shop' },
      approval: { subject: 'template:kubectl-diag', relation: 'approved_for', object: 'operation_profile:sync/argocd-app/shop' },
    });
  });
});
