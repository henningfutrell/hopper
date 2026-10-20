// Cluster discovery (issue #1766, design.md "Minting: short-lived credentials"): a `cluster/<name>` with no minting
// credential of its own is found in the AWS accounts the vault holds a minting credential for. In each, the vault mints a
// read session of the account's read role `hopper-read`, which EKS maps to view access, and asks EKS for the cluster
// (`DescribeCluster`); the cluster's one account signs the EKS token with that session. No vault secret names the
// cluster: it holds no secret. A write on a cluster is no discovery's: it needs a minting credential of its own, which
// names the role its write is granted to, or a cluster override (the config record `clusters`) that names the write role.
// An observe (issue #2146) signs in as the account's role `hopper-observe`.
// An override also renames the cluster for EKS (an alias), and limits the account and the region discovery looks in.
// With no override, a short name (issue #2168) is found by the one cluster the topology lists that it is a prefix of. Pure.
import type { Asset, Operation } from './access.ts';
import type { ClusterOverride } from './clusters.ts';
import { EKS_CLUSTER_NAME, mintingCredentialFor, type MintTarget } from './minting.ts';
import { matchCluster } from './unknown-assets.ts';

/** The role a discovered cluster's token signs in as, in each account: EKS maps it to view access. */
export const EKS_READ_ROLE = 'hopper-read';
/** The role an observe on a discovered cluster signs in as (issue #2146): view access and port-forward, as the cluster's RBAC gives it. */
export const EKS_OBSERVE_ROLE = 'hopper-observe';

/**
 * A cluster to find: its EKS name, the role its token signs in as, and the AWS minting credentials (with their accounts)
 * to look with. The vault looks as `hopper-read`, whatever `role` is. `region`: where to look, in place of each credential's.
 */
export interface ClusterDiscovery { cluster: string; role: string; credentials: { name: string; account: string }[]; region?: string }

/** Where a mint comes from: the one minting credential for its asset, or a cluster to find in the AWS accounts. */
export type MintSource<S> = { credential: S } | { discover: ClusterDiscovery };

/**
 * Where the vault mints `target` for `operation` from, or why from nowhere. A minting credential that mints for the asset
 * wins (one only, issue #1761). A cluster with none is found for a read in every account an AWS minting credential mints
 * for: one each, since the cluster may be in an account with several, and the vault never picks one of those. The
 * cluster's override in `clusters` (issue #1766) names it for EKS, limits the account and the region, and gives a write
 * its role. With no override, `known` (the clusters the topology lists, issue #2168) resolves a short name to the one
 * cluster it is a prefix of; a short name of several is refused with them.
 */
export function mintSourceFor<S extends { name: string; mints?: Asset }>(
  secrets: readonly S[], target: MintTarget, operation: Operation, clusters: readonly ClusterOverride[] = [], known: readonly string[] = [],
): MintSource<S> | string {
  const { mintsFor } = target;
  const own = mintingCredentialFor(secrets, mintsFor);
  if (typeof own !== 'string') return { credential: own };
  if (mintsFor.kind !== 'cluster' || secrets.some((s) => s.mints?.kind === 'cluster' && s.mints.name === mintsFor.name)) return own;
  const override = clusters.find((c) => c.name === mintsFor.name);
  const all = [...new Set(secrets.flatMap((s) => (s.mints?.kind === 'aws-account' ? [s.mints.name] : [])))];
  const accounts = override?.account ? all.filter((a) => a === override.account) : all;
  if (!accounts.length) return override?.account ? `${own}, and no minting credential mints for aws-account ${override.account}, the one account its cluster override names` : `${own}, or one for an aws-account that has the cluster`;
  const role = operation === 'read' ? EKS_READ_ROLE : operation === 'observe' ? EKS_OBSERVE_ROLE : override?.writeRole;
  if (!role) return `${own}: the vault finds a cluster in the AWS accounts for a read only, and ${operation} needs the role its write is granted to (writeRole in the cluster's override on Settings → Clusters)`;
  const match = override ? undefined : matchCluster(mintsFor.name, known);
  if (match?.kind === 'ambiguous') return `${own}: cluster ${mintsFor.name} is ambiguous: ${match.candidates.join(', ')}. Name one of them, or name it in a cluster override on Settings → Clusters`;
  const cluster = override?.eksName ?? (match?.kind === 'short' ? match.to : mintsFor.name);
  if (!EKS_CLUSTER_NAME.test(cluster)) return `${own}: ${cluster} is no EKS cluster name for the vault to find`;
  const credentials: ClusterDiscovery['credentials'] = [];
  for (const account of accounts) {
    const one = mintingCredentialFor(secrets, { kind: 'aws-account', name: account });
    if (typeof one === 'string') return `the vault cannot find cluster ${mintsFor.name}: ${one}`;
    credentials.push({ name: one.name, account });
  }
  return { discover: { cluster, role, credentials, ...(override?.region ? { region: override.region } : {}) } };
}
