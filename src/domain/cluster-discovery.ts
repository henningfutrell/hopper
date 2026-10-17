// Cluster discovery (issue #1766, design.md "Minting: short-lived credentials"): a `cluster/<name>` with no minting
// credential of its own is found in the AWS accounts the vault holds a minting credential for. In each, the vault mints a
// read session of the account's read role `hopper-read`, which EKS maps to view access, and asks EKS for the cluster
// (`DescribeCluster`); the cluster's one account signs the EKS token with that session. No vault secret names the
// cluster: it holds no secret. A write on a cluster is no discovery's: it needs a minting credential of its own, which
// names the role its write is granted to. Pure.
import type { Asset, Operation } from './access.ts';
import { EKS_CLUSTER_NAME, mintingCredentialFor, type MintTarget } from './minting.ts';

/** The role a discovered cluster's token signs in as, in each account: EKS maps it to view access. */
export const EKS_READ_ROLE = 'hopper-read';

/** A cluster to find: its EKS name, the role to sign in as, and the AWS minting credentials (with their accounts) to look with. */
export interface ClusterDiscovery { cluster: string; role: string; credentials: { name: string; account: string }[] }

/** Where a mint comes from: the one minting credential for its asset, or a cluster to find in the AWS accounts. */
export type MintSource<S> = { credential: S } | { discover: ClusterDiscovery };

/**
 * Where the vault mints `target` for `operation` from, or why from nowhere. A minting credential that mints for the asset
 * wins (one only, issue #1761). A cluster with none is found for a read in every account an AWS minting credential mints
 * for: one each, since the cluster may be in an account with several, and the vault never picks one of those.
 */
export function mintSourceFor<S extends { name: string; mints?: Asset }>(secrets: readonly S[], target: MintTarget, operation: Operation): MintSource<S> | string {
  const { mintsFor } = target;
  const own = mintingCredentialFor(secrets, mintsFor);
  if (typeof own !== 'string') return { credential: own };
  if (mintsFor.kind !== 'cluster' || secrets.some((s) => s.mints?.kind === 'cluster' && s.mints.name === mintsFor.name)) return own;
  const accounts = [...new Set(secrets.flatMap((s) => (s.mints?.kind === 'aws-account' ? [s.mints.name] : [])))];
  if (!accounts.length) return `${own}, or one for an aws-account that has the cluster`;
  if (operation !== 'read') return `${own}: the vault finds a cluster in the AWS accounts for a read only, and ${operation} needs the role its write is granted to`;
  if (!EKS_CLUSTER_NAME.test(mintsFor.name)) return `${own}: ${mintsFor.name} is no EKS cluster name for the vault to find`;
  const credentials: ClusterDiscovery['credentials'] = [];
  for (const account of accounts) {
    const one = mintingCredentialFor(secrets, { kind: 'aws-account', name: account });
    if (typeof one === 'string') return `the vault cannot find cluster ${mintsFor.name}: ${one}`;
    credentials.push({ name: one.name, account });
  }
  return { discover: { cluster: mintsFor.name, role: EKS_READ_ROLE, credentials } };
}
