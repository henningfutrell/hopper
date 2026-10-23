// Unknown assets (issue #2067, design.md "Unknown assets"): a need on a cluster that **cluster discovery** would look for —
// no minting credential of its own, no cluster override — and that no AWS source of the user's **infrastructure
// topology** lists. The vault would look for it in every account and find it in none, so a template of it never passes
// its read-only check: a job that asks for it is told at once, with the clusters the topology does list, nearest first,
// so it asks again with the right name. While the topology lists no cluster, no asset is unknown. Issue #2168: a name that
// is the prefix of one listed cluster (a short name, `utility` for `utility-eks`) resolves to it, and discovery finds it by that
// name; the prefix of several is ambiguous, an unknown asset with its candidates, never a guess. Pure.
import { distance } from 'fastest-levenshtein';
import type { Asset, OperationProfile } from './access.ts';
import type { ClusterOverride } from './clusters.ts';
import type { TopologySource } from './topology.ts';

/** The most known clusters an unknown asset names. */
export const KNOWN_MAX = 10;

/**
 * A need's asset the vault cannot find (issue #2067): its cluster, and the clusters the topology lists, nearest first.
 * `candidates`: the clusters an ambiguous short name is the prefix of (issue #2168); absent: no match.
 */
export interface UnknownAsset { asset: Asset; cluster: string; known: string[]; candidates?: string[] }

/** A short cluster name a need gives (issue #2168), and the one cluster the topology lists that it resolves to. */
export interface ShortCluster { cluster: string; to: string }

/** How a cluster name matches the clusters the topology lists (issue #2168): by its full name, as a unique prefix, or not. */
export type ClusterMatch = { kind: 'exact' } | { kind: 'short'; to: string } | { kind: 'ambiguous'; candidates: string[] } | { kind: 'none' };

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

/** How `name` matches `known` (issue #2168): its full name first; else the one cluster it is a prefix of; else several, or none. */
export function matchCluster(name: string, known: readonly string[]): ClusterMatch {
  if (known.includes(name)) return { kind: 'exact' };
  const candidates = known.filter((k) => k.startsWith(name)).sort();
  if (candidates.length === 1) return { kind: 'short', to: candidates[0]! };
  return candidates.length ? { kind: 'ambiguous', candidates } : { kind: 'none' };
}

/** `known` nearest to `name` first: a name that holds it (or that it holds) before the rest, then by edit distance. */
function nearest(name: string, known: readonly string[]): string[] {
  const rank = (k: string): [number, number] => (k.includes(name) || name.includes(k) ? [0, Math.abs(k.length - name.length)] : [1, distance(k, name)]);
  return [...known].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || a.localeCompare(b);
  }).slice(0, KNOWN_MAX);
}

/** Each need's asset that cluster discovery would look for, with its cluster and how it matches the topology. */
function discovered(needs: readonly OperationProfile[], f: ClusterFacts): { asset: Asset; cluster: string; match: ClusterMatch }[] {
  if (f.known.length === 0) return [];
  return needs.flatMap(({ asset }) => {
    const cluster = clusterOf(asset);
    if (!cluster) return [];
    if (f.secrets.some((s) => s.mints?.kind === 'cluster' && s.mints.name === cluster) || f.overrides.some((o) => o.name === cluster)) return [];
    return [{ asset, cluster, match: matchCluster(cluster, f.known) }];
  });
}

/** The needs' assets the vault cannot find (issue #2067), each once; none while the topology lists no cluster. */
export function unknownAssets(needs: readonly OperationProfile[], f: ClusterFacts): UnknownAsset[] {
  const out = new Map<string, UnknownAsset>();
  for (const { asset, cluster, match } of discovered(needs, f)) {
    if (match.kind === 'exact' || match.kind === 'short') continue;
    out.set(`${asset.kind}/${asset.name}`, { asset, cluster, known: nearest(cluster, f.known), ...(match.kind === 'ambiguous' ? { candidates: match.candidates } : {}) });
  }
  return [...out.values()];
}

/** The needs' short cluster names (issue #2168), each once, with the one cluster each resolves to. */
export function shortClusters(needs: readonly OperationProfile[], f: ClusterFacts): ShortCluster[] {
  const out = new Map<string, ShortCluster>();
  for (const { cluster, match } of discovered(needs, f)) if (match.kind === 'short') out.set(cluster, { cluster, to: match.to });
  return [...out.values()];
}

/** An unknown asset in words: `no cluster staging; known: staging-eks, …`, or `cluster utility is ambiguous: utility-eks, utility-gke`. */
export const unknownAssetText = (u: UnknownAsset): string =>
  (u.candidates ? `cluster ${u.cluster} is ambiguous: ${u.candidates.join(', ')}` : `no cluster ${u.cluster}; known: ${u.known.join(', ')}`);
