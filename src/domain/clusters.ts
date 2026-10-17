// Cluster overrides (issue #1766, design.md "Cluster discovery"): the user's config record `clusters`, never a vault
// secret, since a cluster holds no secret. Each one changes how cluster discovery finds one `cluster/<name>`: its name
// in EKS (an alias), the one account and the region to look in, and the IAM role a write signs in as (a write grant such
// as identity edit). A cluster with no override is found as it is named, as `hopper-read`, for a read only. Pure.
import { AWS_REGION_NAME, EKS_CLUSTER_NAME } from './minting.ts';

/** The config record that holds a user's cluster overrides. */
export const CLUSTERS = 'clusters';

/** How discovery finds one cluster. Every field but `name` is optional. */
export interface ClusterOverride {
  /** The hopper's name of the cluster: the asset `cluster/<name>` a template and Access name. */
  name: string;
  /** Its name in EKS, when that is not `name` (an alias). */
  eksName?: string;
  /** The one AWS account to look in (12 digits): it needs an `aws-account` minting credential. */
  account?: string;
  /** The region to look in, in place of the minting credential's. */
  region?: string;
  /** The IAM role (a name, in the account the cluster is found in) a write signs in as. Absent: no write is found. */
  writeRole?: string;
}

/** The record's value. */
export interface ClustersConfig { clusters: ClusterOverride[] }

/** `GET /api/clusters`: the overrides, and the record's version to edit against. */
export interface ClustersView { clusters: ClusterOverride[]; version: string }

export const MAX_CLUSTERS = 100;
/** A hopper cluster name: what an asset `cluster/<name>` may name, and what discovery may look for. */
export const CLUSTER_NAME = EKS_CLUSTER_NAME;
export const AWS_ACCOUNT_ID = /^\d{12}$/;
/** An IAM role name, with no path: the role is `arn:aws:iam::<account>:role/<name>`. */
export const IAM_ROLE_NAME = /^[\w+=,.@-]{1,64}$/;

const FIELDS = ['name', 'eksName', 'account', 'region', 'writeRole'];

/** Why `c` is not a cluster override, or undefined. */
function overrideProblem(c: unknown): string | undefined {
  if (typeof c !== 'object' || c === null || Array.isArray(c)) return 'each cluster override is an object';
  const o = c as Record<string, unknown>;
  const extra = Object.keys(o).find((k) => !FIELDS.includes(k));
  if (extra) return `a cluster override has no field ${extra}`;
  if (typeof o.name !== 'string' || !CLUSTER_NAME.test(o.name)) return 'a cluster override\'s name is a cluster name: letters, digits, _ and -, at most 100';
  const at = `cluster ${o.name}`;
  if (o.eksName !== undefined && (typeof o.eksName !== 'string' || !EKS_CLUSTER_NAME.test(o.eksName))) return `${at}: eksName is the cluster's name in EKS: letters, digits, _ and -, at most 100`;
  if (o.account !== undefined && (typeof o.account !== 'string' || !AWS_ACCOUNT_ID.test(o.account))) return `${at}: account is an AWS account id, 12 digits`;
  if (o.region !== undefined && (typeof o.region !== 'string' || !AWS_REGION_NAME.test(o.region))) return `${at}: region is an AWS region such as eu-west-1`;
  if (o.writeRole !== undefined && (typeof o.writeRole !== 'string' || !IAM_ROLE_NAME.test(o.writeRole))) return `${at}: writeRole is an IAM role name (no path, no ARN), at most 64`;
  if (o.writeRole === 'hopper-read') return `${at}: writeRole is the role a write is granted to, not the read role hopper-read`;
  return undefined;
}

/** Why `raw` cannot be the `clusters` record, or undefined. */
export function clustersProblem(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { clusters?: unknown }).clusters)) return 'the cluster overrides are { "clusters": [...] }';
  const extra = Object.keys(raw).find((k) => k !== 'clusters');
  if (extra) return `the cluster overrides have no field ${extra}`;
  const clusters = (raw as { clusters: unknown[] }).clusters;
  if (clusters.length > MAX_CLUSTERS) return `at most ${MAX_CLUSTERS} cluster overrides`;
  for (const c of clusters) {
    const p = overrideProblem(c);
    if (p) return p;
  }
  const names = clusters.map((c) => (c as ClusterOverride).name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  return twice ? `two cluster overrides are named ${twice}` : undefined;
}

/** The overrides a record holds; none while there is no record, or one that does not load. */
export function clustersOf(raw: unknown): ClusterOverride[] {
  return raw === undefined || clustersProblem(raw) ? [] : (raw as ClustersConfig).clusters;
}
