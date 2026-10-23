// Issue #2067: a need on a cluster that cluster discovery would look for, and that the topology's AWS sources do not
// list, is an unknown asset: the vault will never find it. It names the clusters the topology does list, nearest first.
// A cluster with a minting credential of its own or a cluster override is never unknown, nor any cluster while the
// topology lists none. Issue #2168: a name that is one known cluster's unique short name (a prefix) resolves to it, and
// one that is the prefix of several is ambiguous: an unknown asset with its candidates, never a guess. Pure.
import { describe, expect, it } from 'vitest';
import { needsOf } from '../../src/skills/template-request.ts';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { TopologySource } from '../../src/domain/topology.ts';
import { knownClusters, matchCluster, shortClusters, unknownAssets, unknownAssetText } from '../../src/domain/unknown-assets.ts';

const AT = '2026-10-19T00:00:00.000Z';
const aws = (account: string, region: string, clusters: string[], ok = true): TopologySource => ({
  key: `aws/${account}/${region}`, source: { kind: 'aws', account, region }, reporter: 'topology discovery', lastRead: { at: AT, ok },
  lastGood: { at: AT, links: [], nodes: clusters.map((name) => ({ id: `arn:aws:eks:${region}:${account}:cluster/${name}`, kind: 'cluster' as const, name, account, region })) },
});
const SOURCES = [aws('111111111111', 'us-east-1', ['staging-eks', 'central-eks']), aws('222222222222', 'us-west-2', ['pipeline-eks', 'prod-eks'])];
const needs = (s: string) => needsOf(s) as OperationProfile[];
const facts = (o: Partial<Parameters<typeof unknownAssets>[1]> = {}) => ({ secrets: [], overrides: [], known: knownClusters(SOURCES), ...o });

describe('known clusters', () => {
  it('are the EKS clusters of the AWS sources, each once, sorted', () => {
    const kube: TopologySource = { key: 'kubernetes/lab', source: { kind: 'kubernetes', cluster: 'lab' }, reporter: 'r', lastRead: { at: AT, ok: true }, lastGood: { at: AT, links: [], nodes: [{ id: 'lab', kind: 'cluster', name: 'lab' }] } };
    expect(knownClusters([...SOURCES, aws('333333333333', 'eu-west-1', ['prod-eks']), kube])).toEqual(['central-eks', 'pipeline-eks', 'prod-eks', 'staging-eks']);
  });

  it('keep a source last good snapshot when its last read failed', () => {
    expect(knownClusters([aws('111111111111', 'us-east-1', ['staging-eks'], false)])).toEqual(['staging-eks']);
  });
});

describe('an unknown asset (issue #2067)', () => {
  it('is a cluster need the topology does not list, with the known clusters nearest first', () => {
    const u = unknownAssets(needs('read/cluster/stage read/namespace/pipe-eks/default'), facts());
    expect(u).toEqual([
      { asset: { kind: 'cluster', name: 'stage' }, cluster: 'stage', known: ['staging-eks', 'prod-eks', 'central-eks', 'pipeline-eks'] },
      { asset: { kind: 'namespace', name: 'pipe-eks/default' }, cluster: 'pipe-eks', known: ['prod-eks', 'pipeline-eks', 'staging-eks', 'central-eks'] },
    ]);
    expect(unknownAssetText(u[0]!)).toBe('no cluster stage; known: staging-eks, prod-eks, central-eks, pipeline-eks');
  });

  it('is never a cluster the topology lists, nor an asset of another kind', () => {
    expect(unknownAssets(needs('read/cluster/staging-eks read/aws-role/111111111111/readonly sync/argocd-app/prod-eks/web'), facts())).toEqual([]);
  });

  it('names the cluster of an Argo CD app', () => {
    expect(unknownAssets(needs('sync/argocd-app/central/web'), facts({ known: ['central-eks', 'centralized-eks'] })).map((u) => u.cluster)).toEqual(['central']);
  });

  it('is never a cluster with a minting credential of its own or a cluster override', () => {
    const secrets = [{ name: 'staging-kube', mints: { kind: 'cluster' as const, name: 'staging' } }];
    expect(unknownAssets(needs('read/cluster/stage'), facts({ secrets: [{ ...secrets[0]!, mints: { kind: 'cluster' as const, name: 'stage' } }] }))).toEqual([]);
    expect(unknownAssets(needs('read/cluster/stage'), facts({ overrides: [{ name: 'stage', eksName: 'staging-eks' }] }))).toEqual([]);
  });

  it('is none while the topology lists no cluster', () => {
    expect(unknownAssets(needs('read/cluster/staging'), facts({ known: [] }))).toEqual([]);
  });

  it('names at most ten known clusters', () => {
    const many = knownClusters([aws('111111111111', 'us-east-1', Array.from({ length: 14 }, (_, i) => `c${i}`))]);
    expect(unknownAssets(needs('read/cluster/staging'), facts({ known: many }))[0]!.known).toHaveLength(10);
  });
});

describe('a short cluster name (issue #2168)', () => {
  const utility = (known: string[]) => facts({ known });

  it('resolves to the one known cluster it is a prefix of, and is no unknown asset', () => {
    expect(matchCluster('utility', ['prod-eks', 'utility-eks'])).toEqual({ kind: 'short', to: 'utility-eks' });
    expect(unknownAssets(needs('read/cluster/utility read/namespace/utility/web'), utility(['prod-eks', 'utility-eks']))).toEqual([]);
    expect(shortClusters(needs('read/cluster/utility read/namespace/utility/web read/cluster/prod-eks'), utility(['prod-eks', 'utility-eks']))).toEqual([{ cluster: 'utility', to: 'utility-eks' }]);
  });

  it('is ambiguous when it is the prefix of more than one, with the candidates, and is not guessed', () => {
    expect(matchCluster('utility', ['utility-gke', 'utility-eks'])).toEqual({ kind: 'ambiguous', candidates: ['utility-eks', 'utility-gke'] });
    const u = unknownAssets(needs('read/cluster/utility'), utility(['prod-eks', 'utility-eks', 'utility-gke']));
    expect(u).toEqual([{ asset: { kind: 'cluster', name: 'utility' }, cluster: 'utility', known: ['utility-eks', 'utility-gke', 'prod-eks'], candidates: ['utility-eks', 'utility-gke'] }]);
    expect(unknownAssetText(u[0]!)).toBe('cluster utility is ambiguous: utility-eks, utility-gke');
    expect(shortClusters(needs('read/cluster/utility'), utility(['utility-eks', 'utility-gke']))).toEqual([]);
  });

  it('with no match is an unknown asset with no candidates', () => {
    expect(matchCluster('qa', ['utility-eks'])).toEqual({ kind: 'none' });
    expect(unknownAssets(needs('read/cluster/qa'), utility(['utility-eks']))).toEqual([{ asset: { kind: 'cluster', name: 'qa' }, cluster: 'qa', known: ['utility-eks'] }]);
  });

  it('a full name matches exactly, also when it is the prefix of another', () => {
    expect(matchCluster('utility', ['utility', 'utility-eks'])).toEqual({ kind: 'exact' });
    expect(shortClusters(needs('read/cluster/utility'), utility(['utility', 'utility-eks']))).toEqual([]);
  });

  it('a cluster renamed after the template was saved: one new name it is a prefix of resolves; another name is unknown', () => {
    const saved = needs('read/cluster/utility-eks');
    expect(unknownAssets(saved, utility(['utility-eks-2']))).toEqual([]);
    expect(shortClusters(saved, utility(['utility-eks-2']))).toEqual([{ cluster: 'utility-eks', to: 'utility-eks-2' }]);
    expect(unknownAssets(saved, utility(['acceptance-eks']))).toEqual([{ asset: { kind: 'cluster', name: 'utility-eks' }, cluster: 'utility-eks', known: ['acceptance-eks'] }]);
  });

  it('a cluster override (a configured alias) wins over a short name', () => {
    expect(shortClusters(needs('read/cluster/utility'), facts({ known: ['utility-eks'], overrides: [{ name: 'utility', eksName: 'utility-gke' }] }))).toEqual([]);
  });
});
