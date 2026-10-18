// Topology discovery inside the hopper (issue #1781 part 3, design.md "The infrastructure topology"): what one user's
// discovery run reads, and the keys of its sagas. It reads each AWS account an `aws-account` minting credential mints for,
// as the account's read role `hopper-read`, in every region it has enabled, and each Kubernetes cluster: those EKS lists in
// the accounts, and those a `cluster` minting credential or a cluster override names. Read-only: nothing here acts on a cloud or a cluster. Pure.
import type { Asset } from './access.ts';
import type { ClusterOverride } from './clusters.ts';
import type { Minted } from './minting.ts';
import type { AwsAnswers, KubeAnswers } from './topology-discover.ts';
import type { SourceReport, TopologySource } from './topology.ts';

/** Who a discovery run's reports name: the topology sources say "topology discovery", not a check's API token. */
export const DISCOVERY_REPORTER = 'topology discovery';

/** A discovery's AWS session is named as a job's is, with this in place of the job id. */
export const DISCOVERY_MINT_ID = 'topology-discovery';

/** How often each user's topology is read again: once in each slot of this length. */
export const DISCOVERY_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * What reads an AWS account and a Kubernetes cluster with the credential the vault minted (a port: the AWS SDK and the
 * Kubernetes API in production, a fake in tests). Read calls only. A list the credential may not read is left out; a
 * source none of whose lists can be read throws, saying why.
 */
export interface TopologyReader {
  /** The regions the account has enabled (EC2 `DescribeRegions`), asked in `region`. `endpoint` as for `aws`. */
  awsRegions(r: { account: string; region: string; endpoint?: string; session: Extract<Minted, { kind: 'aws' }> }, signal: AbortSignal): Promise<string[]>;
  /**
   * The account in the region, as the session sees it. `endpoint`: one endpoint for every service (an AWS other than
   * AWS's). `regional`: the region's own lists only, not the global ones (IAM roles, S3 buckets), which the home region reads.
   */
  aws(r: { account: string; region: string; endpoint?: string; session: Extract<Minted, { kind: 'aws' }>; regional?: true }, signal: AbortSignal): Promise<AwsAnswers>;
  /** The cluster `cluster` (its node's id) at `server`, as the token sees it. */
  kube(r: { cluster: string; name: string; server: string; certificateAuthorityData?: string; token: string }, signal: AbortSignal): Promise<KubeAnswers>;
}

/** What a user's discovery reads: the accounts, and the clusters with a minting credential of their own. */
export interface DiscoveryTargets { accounts: string[]; clusters: string[] }

/** The accounts and clusters the vault's minting credentials mint for, each once, in order. */
export function discoveryTargets(secrets: readonly { mints?: Asset }[]): DiscoveryTargets {
  const of = (kind: Asset['kind']): string[] => [...new Set(secrets.flatMap((s) => (s.mints?.kind === kind ? [s.mints.name] : [])))].sort();
  return { accounts: of('aws-account'), clusters: of('cluster') };
}

/**
 * A cluster to read: its name (what the vault mints a token for), its node's id (an EKS cluster's ARN, else its name), and
 * `listed` when EKS listed it in an account.
 */
export interface ClusterToRead { name: string; id: string; listed?: true }

/**
 * The clusters to read (issue #1864: discovery decides, not the vault's entry names): each EKS cluster the accounts listed,
 * by its ARN, then each cluster with a minting credential of its own or an override that no account listed, by its name. A
 * cluster no account listed is a source only when the vault mints for it, or when it held a snapshot before
 * (`readClusters`), so a stale entry is no source. One name EKS has in two accounts is read twice: the vault refuses both,
 * and says why. A cluster an override (issue #1766) names for EKS (`eksName`, in its one `account` when it names one) is
 * minted for by the override's name, the hopper's.
 */
export function clustersToRead(listed: readonly NonNullable<AwsAnswers['clusters']>[number][], own: readonly string[], overrides: readonly ClusterOverride[] = []): ClusterToRead[] {
  const nameOf = (c: { name: string; arn: string }): string =>
    overrides.find((o) => (o.eksName ?? o.name) === c.name && (!o.account || c.arn.split(':')[4] === o.account))?.name ?? c.name;
  const out: ClusterToRead[] = listed.map((c) => ({ name: nameOf(c), id: c.arn, listed: true }));
  for (const name of [...own, ...overrides.map((o) => o.name)]) if (!out.some((c) => c.name === name)) out.push({ name, id: name });
  return out.filter((c, i) => out.findIndex((d) => d.id === c.id) === i);
}

/** The keys of discovery's cluster sources that never held a snapshot and that this run did not report (`reported`: ids). */
export function neverReadClusters(kept: readonly TopologySource[], reported: readonly string[]): string[] {
  return kept.flatMap((s) => (s.source.kind === 'kubernetes' && s.reporter === DISCOVERY_REPORTER && !s.lastGood && !reported.includes(s.source.cluster) ? [s.key] : []));
}

/** The regions to read in an account (issue #1864): its home region (the minting credential's) first, then each one listed, once. */
export function regionsToRead(home: string, listed: readonly string[]): { region: string; home: boolean }[] {
  return [{ region: home, home: true }, ...[...new Set(listed)].filter((r) => r !== home).sort().map((region) => ({ region, home: false }))];
}

/** An account the vault minted nothing for: each source of it kept is read again as failed, so its snapshot says why. */
export function accountUnread(kept: readonly TopologySource[], account: string, error: string): SourceReport[] {
  return kept.flatMap((s) => (s.source.kind === 'aws' && s.source.account === account ? [{ source: s.source, ok: false as const, error }] : []));
}

/** The key of a user's scheduled run in the slot `now` is in: one saga per user and slot, whichever hopper begins it. */
export const scheduledKey = (userId: string, now: Date): string => `${userId}/scheduled/${Math.floor(now.getTime() / DISCOVERY_EVERY_MS)}`;

/** The key of a run a person asked for: each ask its own run, `id` new each time. */
export const askedKey = (userId: string, id: string): string => `${userId}/asked/${id}`;

/** The reports as `report` takes them: at most `max` sources each. */
export function inBatches(reports: readonly SourceReport[], max: number): SourceReport[][] {
  const out: SourceReport[][] = [];
  for (let i = 0; i < reports.length; i += max) out.push(reports.slice(i, i + max));
  return out;
}
