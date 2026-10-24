// EKS sign-in (issue #854, design.md "Minting: short-lived credentials"): a cluster's minting credential of type `eks`
// names an IAM role, not a token. The vault mints a read session of that role from the AWS minting credential for the
// role's account — as for an `aws-role` read, the session named as a job's — and signs an EKS token with it
// (`CredentialMinter.eksToken`). The token only says who the session is: the role's access entry or aws-auth mapping in
// the cluster decides what it may do, and the hopper never changes the cluster. The cluster is named in the credential,
// or found in a vault kubeconfig whose EKS exec sign-in (`aws eks get-token`) names it. Runs where the minting
// credentials are opened: in the hopper, or in the vault's own container. A cluster with no minting credential of its
// own (issue #1766) is found in the AWS accounts the vault mints for, in every region each has enabled (issue #1845,
// `mintDiscovered`), and signed in as `hopper-read`, or for a write as the role its cluster override names.
import { parse } from 'yaml';
import {
  AWS_REGION_NAME, AWS_SESSION_SECONDS, EKS_CLUSTER_NAME, awsReadSession, awsRegionOf, awsSessionName, mintingCredentialFor, mintingCredentialOf, roleAccountOf,
  type AwsMintingCredential, type ClusterIdentity, type EksCluster, type EksMintingCredential, type Minted, type MintReach,
} from '../domain/minting.ts';
import type { CredentialMinter, VaultRepository } from '../domain/ports.ts';
import { isSystemSecret, type VaultSecret } from '../domain/vault.ts';
import { EKS_READ_ROLE, type ClusterDiscovery } from '../domain/cluster-discovery.ts';

type Entry = Record<string, unknown>;
const isEntry = (x: unknown): x is Entry => typeof x === 'object' && x !== null && !Array.isArray(x);
const named = (list: unknown, name: unknown): Entry | undefined => (Array.isArray(list) ? list.find((x): x is Entry => isEntry(x) && x.name === name) : undefined);
const field = (e: Entry | undefined, k: string): Entry | undefined => (isEntry(e?.[k]) ? e[k] : undefined);
const text = (x: unknown): string | undefined => (typeof x === 'string' && x !== '' ? x : undefined);

/** The value after one of `flags` in `args`: `--flag value` or `--flag=value`. */
function argOf(args: string[], ...flags: string[]): string | undefined {
  for (const [i, a] of args.entries()) {
    for (const f of flags) {
      if (a === f) return args[i + 1];
      if (a.startsWith(`${f}=`)) return a.slice(f.length + 1);
    }
  }
  return undefined;
}

/** What a kubeconfig's context says of its cluster: the server, its CA, and the cluster and region its EKS exec signs in to. */
function fromKubeconfig(secret: string, value: string, context: string | undefined, needCluster: boolean): Partial<EksCluster> | string {
  let doc: unknown;
  try { doc = parse(value); } catch { doc = undefined; }
  if (!isEntry(doc)) return `the vault secret ${secret} is not a kubeconfig`;
  const name = context ?? doc['current-context'];
  const ctx = field(named(doc.contexts, name), 'context');
  if (!ctx) return `the kubeconfig ${secret} has no context ${String(name)}`;
  const cluster = field(named(doc.clusters, ctx.cluster), 'cluster');
  const exec = field(field(named(doc.users, ctx.user), 'user'), 'exec');
  const args = Array.isArray(exec?.args) ? exec.args.filter((a): a is string => typeof a === 'string') : [];
  const env = new Map((Array.isArray(exec?.env) ? exec.env : []).filter(isEntry).map((e) => [e.name, text(e.value)]));
  const server = text(cluster?.server);
  const region = argOf(args, '--region') ?? env.get('AWS_REGION') ?? env.get('AWS_DEFAULT_REGION') ?? /\.([a-z0-9-]+)\.eks\.amazonaws\.com(?:\.cn)?(?::\d+)?$/.exec(server ?? '')?.[1];
  const found = {
    cluster: argOf(args, '--cluster-name', '--cluster-id', '-i'), region, server, certificateAuthorityData: text(cluster?.['certificate-authority-data']),
  };
  if (!found.cluster && needCluster) return `the kubeconfig ${secret}'s context ${String(name)} signs in with no EKS exec sign-in that names the cluster (aws eks get-token --cluster-name <name>)`;
  return Object.fromEntries(Object.entries(found).filter(([, v]) => v !== undefined));
}

/** The cluster `c` signs in to: as it names it, the rest from the kubeconfig's value; or why there is none. */
export function eksClusterOf(c: EksMintingCredential, kubeconfig: string | undefined): EksCluster | string {
  let found: Partial<EksCluster> = {};
  if (c.kubeconfig) {
    if (kubeconfig === undefined) return `the vault holds no kubeconfig ${c.kubeconfig}`;
    const read = fromKubeconfig(c.kubeconfig, kubeconfig, c.context, !c.cluster);
    if (typeof read === 'string') return read;
    found = read;
  }
  const cluster = c.cluster ?? found.cluster;
  const region = c.region ?? found.region;
  const server = c.server ?? found.server;
  const ca = c.certificateAuthorityData ?? found.certificateAuthorityData;
  if (!cluster || !EKS_CLUSTER_NAME.test(cluster)) return `${JSON.stringify(cluster ?? '')} is no EKS cluster name`;
  if (!region || !AWS_REGION_NAME.test(region)) return `the cluster ${cluster} has no AWS region: name region in the minting credential`;
  if (!server || !/^https?:\/\//.test(server)) return `the cluster ${cluster} has no API server URL: name server in the minting credential`;
  return { cluster, region, server, ...(ca ? { certificateAuthorityData: ca } : {}) };
}

export interface EksMinted { minted: Minted; reach: MintReach; roleArn: string; sessionName: string; cluster?: ClusterIdentity }

type EksOptions = { vault: Pick<VaultRepository, 'get' | 'list'>; minter: CredentialMinter; valueOf(secret: VaultSecret): Promise<{ value: string } | { refused: string }> };

/** The token for `cluster` signed with `session` of `roleArn`, and where it is used; with `identify`, who the cluster says it is. */
async function signedFor(o: EksOptions, session: Extract<Minted, { kind: 'aws' }>, cluster: EksCluster, roleArn: string, sessionName: string, identify?: boolean): Promise<EksMinted> {
  const minted = await o.minter.eksToken(session, cluster);
  const reach = { kind: 'kube' as const, server: cluster.server, ...(cluster.certificateAuthorityData ? { certificateAuthorityData: cluster.certificateAuthorityData } : {}) };
  return { minted, reach, roleArn, sessionName, ...(identify ? { cluster: await o.minter.kubeIdentity(reach, minted.token) } : {}) };
}

/** Where a discovery looked in one account: the regions, and why only the credential's when its regions could not be listed. */
export interface Searched { account: string; regions: string[] }

/**
 * Mints an EKS token for a cluster with no minting credential of its own (issue #1766): in each account of `d`, a read
 * session of `hopper-read` from the account's minting credential, and `DescribeCluster` in `d.region`, else in every
 * region EC2 says the account has enabled (issue #1845, `awsRegions`), else, when it cannot say, the credential's region.
 * The one place (account and region) that has the cluster signs the token with that session, or, when `d.role` is
 * another role (a write's, from the cluster's override), with a session of that role in the same account; none, or
 * several, mint nothing. An account STS or EKS refuses is passed over, and said when no account has the cluster. The
 * answer names the AWS minting credential, the account and the region it used, and where it looked.
 */
export async function mintDiscovered(o: EksOptions, d: ClusterDiscovery, jobId: string, identify?: boolean): Promise<(EksMinted & { credential: string; account: string; region: string; searched: Searched[] }) | { refused: string }> {
  const found: { credential: string; account: string; keys: AwsMintingCredential; roleArn: string; sessionName: string; session: Extract<Minted, { kind: 'aws' }>; cluster: EksCluster }[] = [];
  const looked: string[] = [];
  const searched: Searched[] = [];
  for (const { name, account } of d.credentials) {
    const secret = o.vault.get(name);
    const read = secret ? await o.valueOf(secret) : { refused: 'the vault holds no secret of that name' };
    if ('refused' in read) return { refused: `the AWS minting credential ${name}: ${read.refused}` };
    const keys = mintingCredentialOf('aws', read.value);
    if (typeof keys === 'string') return { refused: `the AWS minting credential ${name}: ${keys}` };
    const roleArn = `arn:aws:iam::${account}:role/${EKS_READ_ROLE}`;
    const sessionName = awsSessionName(keys, jobId);
    const home = d.region ?? awsRegionOf(keys);
    // An STS that is not AWS's has no EKS of AWS's beside it: the vault asks one only when the credential names it.
    if (keys.Endpoint && !keys.EksEndpoint) {
      looked.push(`${account}: ${name} names an STS endpoint and no EksEndpoint`);
      continue;
    }
    let session: Extract<Minted, { kind: 'aws' }>;
    try {
      session = await o.minter.awsSession(keys, { roleArn, sessionName, ...awsReadSession(roleArn), durationSeconds: AWS_SESSION_SECONDS });
    } catch (e) {
      // An account the read role cannot look in has no cluster for the vault to find: the others may.
      looked.push(`${account} in ${home}: ${(e as Error).message}`);
      continue;
    }
    // An override's region, or an EKS that is not AWS's, is one region: the vault lists the account's only for AWS's.
    let regions = [home];
    let unlisted = '';
    if (!d.region && !keys.EksEndpoint) {
      regions = await o.minter.awsRegions(session, { account, region: home }).catch((e: unknown) => {
        unlisted = ` (its regions could not be listed: ${(e as Error).message})`;
        return [home];
      });
    }
    searched.push({ account, regions });
    const asked = await Promise.all(regions.map(async (region) => {
      try {
        return { region, cluster: await o.minter.eksCluster(session, { cluster: d.cluster, region, ...(keys.EksEndpoint ? { endpoint: keys.EksEndpoint } : {}) }) };
      } catch (e) {
        return { region, error: (e as Error).message };
      }
    }));
    const none = asked.filter((a) => !a.cluster && !a.error).map((a) => a.region);
    const at = asked.filter((a) => a.cluster).map((a) => a.region);
    looked.push(...[
      ...(at.length ? [`${account} in ${at.join(', ')}: found`] : []),
      ...(none.length ? [`${account} in ${none.join(', ')}${unlisted}: none`] : []),
      ...asked.flatMap((a) => (a.error ? [`${account} in ${a.region}: ${a.error}`] : [])),
    ]);
    for (const a of asked) if (a.cluster) found.push({ credential: name, account, keys, roleArn, sessionName, session, cluster: a.cluster });
  }
  if (!found.length) return { refused: `no minting credential mints for cluster ${d.cluster}, and the vault found it in none of the accounts it mints for (${looked.join('; ')})` };
  if (found.length > 1) return { refused: `EKS has a cluster ${d.cluster} in ${found.length} places: ${found.map((f) => `${f.account} in ${f.cluster.region} (${f.credential})`).join(', ')}. The vault does not pick one: a person adds a minting credential for cluster ${d.cluster} on Vault, or names its account and region in the cluster's override on Settings → Clusters` };
  const [f] = found as [typeof found[number]];
  const where = { credential: f.credential, account: f.account, region: f.cluster.region, searched };
  if (d.role === EKS_READ_ROLE) return { ...await signedFor(o, f.session, f.cluster, f.roleArn, f.sessionName, identify), ...where };
  // A write signs in as the role its write is granted to, an observe as hopper-observe (issue #2146): EKS maps that role, and the cluster's access entry decides.
  const roleArn = `arn:aws:iam::${f.account}:role/${d.role}`;
  // Issue #2340: the minting identity may assume hopper-read and not this role. Say both places a person changes.
  const session = await o.minter.awsSession(f.keys, { roleArn, sessionName: f.sessionName, ...awsReadSession(roleArn), durationSeconds: AWS_SESSION_SECONDS }).catch((e: unknown) => {
    throw new Error(`${(e as Error).message}. The identity of the minting credential ${f.credential} needs sts:AssumeRole on ${roleArn} in its own policy, and that role's trust policy must let it assume the role (docs/deploy.md "The observe role")`, { cause: e });
  });
  return { ...await signedFor(o, session, f.cluster, roleArn, f.sessionName, identify), ...where };
}

/**
 * Mints an EKS token from the minting credential `name` (its value `c`) for the job `jobId`: the kubeconfig and the AWS
 * minting credential are read in the vault, never given out. `identify` (a mint test): the cluster says who the token
 * is. A refusal says why; an outside service's error is thrown, for the caller to say.
 */
export async function mintEks(
  o: EksOptions, name: string, c: EksMintingCredential, jobId: string, identify?: boolean,
): Promise<EksMinted | { refused: string; kubeconfigGone?: true }> {
  const refuse = (why: string) => ({ refused: `the minting credential ${name}: ${why}` });
  let kubeconfig: string | undefined;
  if (c.kubeconfig) {
    const secret = isSystemSecret(c.kubeconfig) ? undefined : o.vault.get(c.kubeconfig);
    // Issue #1845: the caller passes over a credential whose kubeconfig is gone, and finds the cluster in its place.
    if (!secret) return { ...refuse(`it names the kubeconfig ${c.kubeconfig}, and the vault holds no secret of that name`), kubeconfigGone: true };
    const read = await o.valueOf(secret);
    if ('refused' in read) return refuse(read.refused);
    kubeconfig = read.value;
  }
  const cluster = eksClusterOf(c, kubeconfig);
  if (typeof cluster === 'string') return refuse(cluster);
  const account = roleAccountOf(c.roleArn);
  const aws = mintingCredentialFor(o.vault.list(), { kind: 'aws-account', name: account });
  if (typeof aws === 'string') return refuse(`its EKS sign-in assumes ${c.roleArn}: ${aws}`);
  const read = await o.valueOf(aws);
  if ('refused' in read) return refuse(`the AWS minting credential ${aws.name}: ${read.refused}`);
  const keys = mintingCredentialOf('aws', read.value);
  if (typeof keys === 'string') return refuse(`the AWS minting credential ${aws.name}: ${keys}`);
  const sessionName = awsSessionName(keys, jobId);
  const session = await o.minter.awsSession(keys, { roleArn: c.roleArn, sessionName, ...awsReadSession(c.roleArn), durationSeconds: AWS_SESSION_SECONDS });
  return signedFor(o, session, cluster, c.roleArn, sessionName, identify);
}
