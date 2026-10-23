// Issue #2146 (the bastion path, part 1): the **observe** operation. A bastion's credential reads a cluster or a namespace
// and port-forwards to its pods: the service account `hopper-observe`, or, for a cluster the vault finds in the AWS
// accounts, the IAM role `hopper-observe`, whose RBAC the cluster gives. Observe changes no asset, so it needs no plan
// and infra applies off do not stop it; but a forward reaches every port of a pod, so it is a high-radius profile: only
// its own explicit approval approves it, and no read policy holds it. A model edited before it still decides every other
// mint: its gaps are apart, and only observe is then denied.
import { afterEach, describe, expect, it } from 'vitest';
import { changesAsset, OPERATIONS, type OperationProfile } from '../../src/domain/access.ts';
import { mintTarget, type MintTarget } from '../../src/domain/minting.ts';
import { mintSourceFor } from '../../src/domain/cluster-discovery.ts';
import { applyRefusal, appliesRefusal } from '../../src/domain/infra-plans.ts';
import { highRadius, rateTemplate } from '../../src/blast-radius/template.ts';
import { profileNeedsPerson } from '../../src/domain/confirmation-asks.ts';
import { compileAccessModel, DEFAULT_ACCESS_MODEL, modelGaps, observeGaps } from '../../src/authz/model.ts';
import { createAccess } from '../../src/authz/service.ts';
import { DEFAULT_BLAST_RADIUS_SETTINGS, type LiveRequesters } from '../../src/domain/types.ts';
import type { VaultSecret } from '../../src/domain/vault.ts';
import { openInstanceStore, type InstanceStore } from '../../src/store/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { testDatabaseUrl } from '../support/database.ts';

const UTILITY = '111111111111';
const CLUSTER = { kind: 'cluster', name: 'utility' } as const;
const MONITORING = { kind: 'namespace', name: 'utility/monitoring' } as const;
const observe = (asset: OperationProfile['asset']): OperationProfile => ({ operation: 'observe', asset });
const aws: VaultSecret = { id: 'id-m', name: 'MINTER_UTILITY', setBy: 'admin', createdAt: '2030-01-01T00:00:00Z', changedBy: 'admin', changedAt: '2030-01-01T00:00:00Z', mints: { kind: 'aws-account', name: UTILITY } };

describe('the observe operation (issue #2146)', () => {
  it('is an operation, and no change of its asset', () => {
    expect(OPERATIONS).toContain('observe');
    expect(changesAsset(observe(CLUSTER))).toBe(false);
    expect(changesAsset({ operation: 'read' })).toBe(false);
    for (const operation of ['write', 'sync', 'apply'] as const) expect(changesAsset({ operation })).toBe(true);
  });

  it('mints the service account hopper-observe for a cluster or a namespace', () => {
    expect(mintTarget('kube', observe(CLUSTER))).toEqual({ kind: 'kube', mintsFor: CLUSTER, namespace: 'hopper', serviceAccount: 'hopper-observe', expirationSeconds: 600 });
    expect(mintTarget('kube', observe(MONITORING))).toEqual({ kind: 'kube', mintsFor: CLUSTER, namespace: 'monitoring', serviceAccount: 'hopper-observe', expirationSeconds: 600 });
  });

  it('mints nothing for an AWS role or an Argo CD app', () => {
    expect(mintTarget('aws', observe({ kind: 'aws-role', name: `${UTILITY}/hopper-read` }))).toMatch(/^observe is minted for a cluster or a namespace only/);
    expect(mintTarget('kube', observe({ kind: 'argocd-app', name: 'utility/web' }))).toMatch(/^an argocd-app takes sync only/);
  });

  it('finds a cluster in the AWS accounts as the role hopper-observe', () => {
    const target = mintTarget('kube', observe(MONITORING)) as MintTarget;
    expect(mintSourceFor([aws], target, 'observe')).toEqual({ discover: { cluster: 'utility', role: 'hopper-observe', credentials: [{ name: 'MINTER_UTILITY', account: UTILITY }] } });
  });

  it('needs no plan, and infra applies off do not stop it', () => {
    const now = new Date('2026-10-20T10:00:00Z');
    expect(applyRefusal(observe(CLUSTER), undefined, undefined, undefined, now)).toBeUndefined();
    expect(appliesRefusal(observe(CLUSTER), false)).toBeUndefined();
  });

  it('is high radius: only its own approval approves it, and a person confirms it', () => {
    expect(highRadius(observe(CLUSTER))).toBe(true);
    expect(profileNeedsPerson(observe(CLUSTER))).toBe(true);
    const r = rateTemplate({ secrets: [], profiles: [observe(MONITORING)] }, [], DEFAULT_BLAST_RADIUS_SETTINGS.rules);
    expect(r.level).toBe('high');
    expect(r.reasons).toEqual(['observe on namespace utility/monitoring: it port-forwards to the asset\'s pods; waits for an explicit approval']);
  });
});

describe('observe in the access model (issue #2146)', () => {
  const before = DEFAULT_ACCESS_MODEL.replace(/\n {4}define grants_observe: [^\n]*/, '').replace(/\n {4}define can_observe: [^\n]*/, '');

  it('the default model holds it with no gap', () => {
    expect(observeGaps(compileAccessModel(DEFAULT_ACCESS_MODEL))).toEqual([]);
  });

  it('a model edited before it still decides every other mint: its gaps are apart', () => {
    expect(before).not.toContain('observe');
    const json = compileAccessModel(before);
    expect(modelGaps(json)).toEqual([]);
    expect(observeGaps(json)).toEqual(['asset#grants_observe', 'asset#can_observe']);
  });

  const stores: InstanceStore[] = [];
  afterEach(() => { for (const s of stores.splice(0)) s.close(); });

  function accessWith(dsl?: string) {
    const instance = openInstanceStore({ url: testDatabaseUrl(), clock: { now: () => new Date('2026-10-20T12:00:00Z') } });
    stores.push(instance);
    if (dsl) instance.access.addModel(dsl, 'Ada', '2026-10-20T11:00:00Z');
    const live = (): LiveRequesters[] => [{ userId: 'u1', jobs: [{ jobId: 'j1', machine: 'kbox' }], boxes: [{ machine: 'kbox', template: 'kube' }] }];
    const fga = createFakeAuthorizationServer();
    const access = createAccess({ repo: instance.access, server: fga, clock: { now: () => new Date('2026-10-20T12:00:00Z') }, logger: { warn: () => undefined }, jobStatus: () => 'running', requesters: live });
    return access;
  }
  const ask = (operation: 'read' | 'observe') => ({ requester: { kind: 'job', userId: 'u1', jobId: 'j1' }, operation, asset: MONITORING } as const);

  it('with the default model, an approved observe is allowed', async () => {
    const access = accessWith();
    await access.approve('kube', observe(MONITORING), 'Ada');
    expect((await access.decideMint(ask('observe'))).allowed).toBe(true);
  });

  it('with a model edited before it, an observe approval is kept but not pushed; observe is denied and read still decided', async () => {
    const access = accessWith(before);
    await access.approve('kube', observe(MONITORING), 'Ada');
    await access.approve('kube', { operation: 'read', asset: MONITORING }, 'Ada');
    expect((await access.decideMint(ask('read'))).allowed).toBe(true);
    const denied = await access.decideMint(ask('observe'));
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/the access model lacks what observe needs: asset#grants_observe, asset#can_observe/);
  });
});
