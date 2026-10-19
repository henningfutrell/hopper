// Unknown assets (issue #2067, design.md "Unknown assets"): a need on a cluster that **cluster discovery** would look for —
// no minting credential of its own, no cluster override — and that no AWS source of the user's **infrastructure
// topology** lists. The vault would look for it in every account and find it in none, so a template of it never passes
// its read-only check: a job that asks for it is told at once, with the clusters the topology does list, nearest first,
// so it asks again with the right name. While the topology lists no cluster, no asset is unknown. Pure.
import { distance } from 'fastest-levenshtein';
import type { Asset, OperationProfile } from './access.ts';
import type { ClusterOverride } from './clusters.ts';
import type { TopologySource } from './topology.ts';

/** The most known clusters an unknown asset names. */
export const KNOWN_MAX = 10;

/** A need's asset the vault cannot find (issue #2067): its cluster, and the clusters the topology lists, nearest first. */
export interface UnknownAsset { asset: Asset; cluster: string; known: string[] }

/** What decides it: the vault's minting credentials, the user's cluster overrides, and the clusters the topology lists. */
export interface ClusterFacts { secrets: readonly { mints?: Asset }[]; overrides: readonly ClusterOverride[]; known: readonly string[] }

/** The EKS clusters the topology's AWS sources list in their last good snapshots, each once, sorted. */
export function knownClusters(sources: readonly Pick<TopologySource, 'source' | 'lastGood'>[]): string[] {
  const names = sources.flatMap((s) => (s.source.kind === 'aws' ? (s.lastGood?.nodes ?? []).filter((n) => n.kind === 'cluster').map((n) => n.name) : []));
  return [...new Set(names)].sort();
}

/** The cluster an asset is on: a cluster's own name, a namespace's or an Argo CD app's first part; none for other kinds. */
export function clusterOf(a: Asset): string | undefined {
  if (a.kind === 'cluster') return a.name;
  return a.kind === 'namespace' || a.kind === 'argocd-app' ? a.name.split('/')[0] : undefined;
}

/** `known` nearest to `name` first: a name that holds it (or that it holds) before the rest, then by edit distance. */
function nearest(name: string, known: readonly string[]): string[] {
  const rank = (k: string): [number, number] => (k.includes(name) || name.includes(k) ? [0, Math.abs(k.length - name.length)] : [1, distance(k, name)]);
  return [...known].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || a.localeCompare(b);
  }).slice(0, KNOWN_MAX);
}

/** The needs' assets the vault cannot find (issue #2067), each once; none while the topology lists no cluster. */
export function unknownAssets(needs: readonly OperationProfile[], f: ClusterFacts): UnknownAsset[] {
  if (f.known.length === 0) return [];
  const out = new Map<string, UnknownAsset>();
  for (const { asset } of needs) {
    const cluster = clusterOf(asset);
    if (!cluster || f.known.includes(cluster)) continue;
    if (f.secrets.some((s) => s.mints?.kind === 'cluster' && s.mints.name === cluster) || f.overrides.some((o) => o.name === cluster)) continue;
    out.set(`${asset.kind}/${asset.name}`, { asset, cluster, known: nearest(cluster, f.known) });
  }
  return [...out.values()];
}

/** An unknown asset in words: `no cluster staging; known: staging-eks, …`. */
export const unknownAssetText = (u: UnknownAsset): string => `no cluster ${u.cluster}; known: ${u.known.join(', ')}`;
