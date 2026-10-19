// Issue #2067: a need on a cluster that cluster discovery would look for, and that the topology's AWS sources do not
// list, is an unknown asset: the vault will never find it. It names the clusters the topology does list, nearest first.
// A cluster with a minting credential of its own or a cluster override is never unknown, nor any cluster while the
// topology lists none. Pure.
import { describe, expect, it } from 'vitest';
import { needsOf } from '../../src/skills/template-request.ts';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { TopologySource } from '../../src/domain/topology.ts';
import { knownClusters, unknownAssets, unknownAssetText } from '../../src/domain/unknown-assets.ts';

const AT = '2026-10-19T00:00:00.000Z';
const aws = (account: string, region: string, clusters: string[], ok = true): TopologySource => ({
  key: `aws/${account}/${region}`, source: { kind: 'aws', account, region }, reporter: 'topology discovery', lastRead: { at: AT, ok },
  lastGood: { at: AT, links: [], nodes: clusters.map((name) => ({ id: `arn:aws:eks:${region}:${account}:cluster/${name}`, kind: 'cluster' as const, name, account, region })) },
});
const SOURCES = [aws('111111111111', 'us-east-1', ['staging-eks', 'control-plane-eks']), aws('222222222222', 'us-west-2', ['platform-cluster-eks', 'prod-eks'])];
const needs = (s: string) => needsOf(s) as OperationProfile[];
const facts = (o: Partial<Parameters<typeof unknownAssets>[1]> = {}) => ({ secrets: [], overrides: [], known: knownClusters(SOURCES), ...o });

describe('known clusters', () => {
  it('are the EKS clusters of the AWS sources, each once, sorted', () => {
    const kube: TopologySource = { key: 'kubernetes/lab', source: { kind: 'kubernetes', cluster: 'lab' }, reporter: 'r', lastRead: { at: AT, ok: true }, lastGood: { at: AT, links: [], nodes: [{ id: 'lab', kind: 'cluster', name: 'lab' }] } };
    expect(knownClusters([...SOURCES, aws('333333333333', 'eu-west-1', ['prod-eks']), kube])).toEqual(['control-plane-eks', 'platform-cluster-eks', 'prod-eks', 'staging-eks']);
  });

  it('keep a source last good snapshot when its last read failed', () => {
    expect(knownClusters([aws('111111111111', 'us-east-1', ['staging-eks'], false)])).toEqual(['staging-eks']);
  });
});

describe('an unknown asset (issue #2067)', () => {
  it('is a cluster need the topology does not list, with the known clusters nearest first', () => {
    const u = unknownAssets(needs('read/cluster/staging read/namespace/platform/default'), facts());
    expect(u).toEqual([
      { asset: { kind: 'cluster', name: 'staging' }, cluster: 'staging', known: ['staging-eks', 'prod-eks', 'control-plane-eks', 'platform-cluster-eks'] },
      { asset: { kind: 'namespace', name: 'platform/default' }, cluster: 'platform', known: ['platform-cluster-eks', 'prod-eks', 'staging-eks', 'control-plane-eks'] },
    ]);
    expect(unknownAssetText(u[0]!)).toBe('no cluster staging; known: staging-eks, prod-eks, control-plane-eks, platform-cluster-eks');
  });

  it('is never a cluster the topology lists, nor an asset of another kind', () => {
    expect(unknownAssets(needs('read/cluster/staging-eks read/aws-role/111111111111/readonly sync/argocd-app/prod-eks/web'), facts())).toEqual([]);
  });

  it('names the cluster of an Argo CD app', () => {
    expect(unknownAssets(needs('sync/argocd-app/control-plane/web'), facts()).map((u) => u.cluster)).toEqual(['control-plane']);
  });

  it('is never a cluster with a minting credential of its own or a cluster override', () => {
    const secrets = [{ name: 'staging-kube', mints: { kind: 'cluster' as const, name: 'staging' } }];
    expect(unknownAssets(needs('read/cluster/staging'), facts({ secrets }))).toEqual([]);
    expect(unknownAssets(needs('read/cluster/staging'), facts({ overrides: [{ name: 'staging', eksName: 'staging-eks' }] }))).toEqual([]);
  });

  it('is none while the topology lists no cluster', () => {
    expect(unknownAssets(needs('read/cluster/staging'), facts({ known: [] }))).toEqual([]);
  });

  it('names at most ten known clusters', () => {
    const many = knownClusters([aws('111111111111', 'us-east-1', Array.from({ length: 14 }, (_, i) => `c${i}`))]);
    expect(unknownAssets(needs('read/cluster/staging'), facts({ known: many }))[0]!.known).toHaveLength(10);
  });
});
