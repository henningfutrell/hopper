// Issue #542: a machine's blast radius, rated from what its discovery found. Read-only reach is low; write reach is
// medium; write reach to prod, or reach that can grant itself more, is high. What discovery could not confirm counts
// as a write unless the rules say otherwise. Every level carries its evidence.
import { describe, expect, it } from 'vitest';
import { changesOf, gateOf, rate } from '../../src/blast-radius/rate.ts';
import { DEFAULT_BLAST_RADIUS_SETTINGS, type AwsIdentity, type DiscoveryFacts, type KubeContext } from '../../src/domain/types.ts';

const rules = DEFAULT_BLAST_RADIUS_SETTINGS.rules;
const facts = (over: Partial<DiscoveryFacts> = {}): DiscoveryFacts => ({
  path: ['/usr/bin'], bins: [{ dir: '/usr/bin', name: 'sh' }], versions: {}, aws: [], kube: [], credentials: { env: [], files: [] }, ...over,
});
const WRITES = ['s3:PutObject', 's3:DeleteObject', 'ec2:TerminateInstances', 'iam:CreateUser', 'iam:AttachRolePolicy'];
const aws = (profile: string, account: string, allowed: string[], over: Partial<AwsIdentity> = {}): AwsIdentity => ({
  profile, account, arn: `arn:aws:sts::${account}:assumed-role/${profile}-role/s`,
  simulated: WRITES.map((action) => ({ action, decision: allowed.includes(action) ? 'allowed' : 'implicitDeny' })), ...over,
});
const kube = (name: string, yes: string[], over: Partial<KubeContext> = {}): KubeContext => ({
  name, cluster: `${name}-cluster`, current: false,
  can: ['create deployments', 'delete pods', 'get secrets', '* *'].map((check) => ({ check, answer: yes.includes(check) ? 'yes' : 'no' })), ...over,
});

describe('rating a machine', () => {
  it('nothing reached: low', () => {
    expect(rate(facts(), rules)).toEqual({ level: 'low', reach: [], reasons: ['no credentials or access found'] });
  });

  it('read-only AWS, confirmed by simulation: low', () => {
    const r = rate(facts({ aws: [aws('dev', '111111111111', [])] }), rules);
    expect(r.level).toBe('low');
    expect(r.reach).toEqual([expect.objectContaining({ kind: 'aws', access: 'read', prod: false })]);
  });

  it('write to a non-prod account: medium, with the allowed actions as evidence', () => {
    const r = rate(facts({ aws: [aws('dev', '111111111111', ['s3:PutObject'])] }), rules);
    expect(r.level).toBe('medium');
    expect(r.reasons).toEqual([expect.stringContaining('s3:PutObject')]);
  });

  it('write to prod — by name, or by account id — is high', () => {
    expect(rate(facts({ aws: [aws('prod-deploy', '222222222222', ['s3:PutObject'])] }), rules).level).toBe('high');
    const byAccount = { ...rules, prodAccounts: ['333333333333'] };
    expect(rate(facts({ aws: [aws('ops', '333333333333', ['s3:PutObject'])] }), byAccount).level).toBe('high');
    expect(rate(facts({ aws: [aws('ops', '333333333333', ['s3:PutObject'])] }), rules).level).toBe('medium');
  });

  it('IAM writes make an admin, high even outside prod', () => {
    const r = rate(facts({ aws: [aws('dev', '111111111111', ['iam:AttachRolePolicy'])] }), rules);
    expect(r).toMatchObject({ level: 'high', reach: [expect.objectContaining({ access: 'admin' })] });
  });

  it('an identity whose simulation was refused is unconfirmed: a write by default, read when the rules say so', () => {
    const facts1 = facts({ aws: [aws('prod', '222222222222', [], { simulated: undefined, simulationError: 'AccessDenied' })] });
    expect(rate(facts1, rules)).toMatchObject({ level: 'high', reach: [expect.objectContaining({ access: 'unconfirmed' })] });
    expect(rate(facts1, { ...rules, unconfirmed: 'read' }).level).toBe('low');
  });

  it('a root identity is an admin', () => {
    const r = rate(facts({ aws: [{ profile: 'x', account: '1', arn: 'arn:aws:iam::1:root', simulationError: 'root' }] }), rules);
    expect(r.reach[0]).toMatchObject({ access: 'admin' });
    expect(r.level).toBe('high');
  });

  it('an identity AWS refused reaches nothing', () => {
    expect(rate(facts({ aws: [{ profile: 'old', error: 'ExpiredToken' }] }), rules).level).toBe('low');
  });

  it('kubernetes: read-only low, writes medium, prod cluster writes high, every verb on everything admin', () => {
    expect(rate(facts({ kube: [kube('dev', ['get secrets'])] }), rules).level).toBe('low');
    expect(rate(facts({ kube: [kube('dev', ['create deployments'])] }), rules).level).toBe('medium');
    expect(rate(facts({ kube: [kube('dev', ['delete pods'], { cluster: 'eks-production' })] }), rules).level).toBe('high');
    expect(rate(facts({ kube: [kube('dev', ['* *'])] }), rules).reach[0]).toMatchObject({ access: 'admin' });
  });

  it('a context whose checks failed is unconfirmed', () => {
    const ctx: KubeContext = { name: 'staging', current: true, can: [{ check: 'create deployments', answer: 'error: the server could not be reached' }] };
    expect(rate(facts({ kube: [ctx] }), rules)).toMatchObject({ level: 'medium', reach: [expect.objectContaining({ access: 'unconfirmed' })] });
  });

  it('a credential source no identity accounts for is unconfirmed; a terraform token reaches terraform', () => {
    const r = rate(facts({ credentials: { env: ['TF_TOKEN_app_terraform_io'], files: ['aws-credentials'] } }), rules);
    expect(r.reach.map((x) => [x.kind, x.target, x.access])).toEqual([
      ['terraform', 'TF_TOKEN_app_terraform_io', 'unconfirmed'],
      ['credential', 'aws-credentials', 'unconfirmed'],
    ]);
    expect(r.level).toBe('medium');
  });

  it('AWS credential files are accounted for once an AWS identity was found', () => {
    const r = rate(facts({ aws: [aws('dev', '1', [])], credentials: { env: ['AWS_PROFILE'], files: ['aws-config', 'aws-credentials'] } }), rules);
    expect(r.reach.map((x) => x.kind)).toEqual(['aws']);
  });
});

describe('what a discovery changed', () => {
  it('the first: everything is new', () => {
    expect(changesOf(undefined, facts(), undefined, 'low')).toEqual({ first: true, added: [], removed: [] });
  });

  it('tools, identities, contexts and credential sources that came or went, and the level when it moved', () => {
    const before = facts({ aws: [aws('dev', '1', [])], credentials: { env: ['AWS_PROFILE'], files: [] } });
    const after = facts({
      bins: [{ dir: '/usr/bin', name: 'sh' }, { dir: '/usr/local/bin', name: 'kubectl' }],
      kube: [kube('prod', ['create deployments'])], credentials: { env: [], files: ['kubeconfig'] },
    });
    expect(changesOf(before, after, 'low', 'high')).toEqual({
      first: false,
      added: ['tool /usr/local/bin/kubectl', 'kubernetes prod', 'credential file kubeconfig'],
      removed: ['aws dev', 'credential variable AWS_PROFILE'],
      level: { from: 'low', to: 'high' },
    });
  });
});

describe('the gate', () => {
  const s = DEFAULT_BLAST_RADIUS_SETTINGS;
  it('gates a machine rated at or above the level; an actor machine always; nothing never discovered', () => {
    expect(gateOf('m', 'high', s)).toBe('rated high');
    expect(gateOf('m', 'medium', s)).toBeUndefined();
    expect(gateOf('m', 'medium', { ...s, gateAt: 'medium' })).toBe('rated medium');
    expect(gateOf('m', 'high', { ...s, gateAt: 'off' })).toBeUndefined();
    expect(gateOf('m', undefined, s)).toBeUndefined();
    const actors = { ...s, gateAt: 'off' as const, actors: [{ machineId: 'm', purpose: 'prod deploys', expected: 'high' as const }] };
    expect(gateOf('m', undefined, actors)).toBe('an actor machine (prod deploys)');
  });
});
