// EKS sign-in (issue #854, design.md "Minting: short-lived credentials"): a cluster's minting credential of type `eks`
// names an IAM role, not a token. The vault mints a read session of that role from the AWS minting credential for the
// role's account — as for an `aws-role` read, the session named as a job's — and signs an EKS token with it
// (`CredentialMinter.eksToken`). The token only says who the session is: the role's access entry or aws-auth mapping in
// the cluster decides what it may do, and the hopper never changes the cluster. The cluster is named in the credential,
// or found in a vault kubeconfig whose EKS exec sign-in (`aws eks get-token`) names it. Runs where the minting
// credentials are opened: in the hopper, or in the vault's own container.
import { parse } from 'yaml';
import {
  AWS_REGION_NAME, AWS_SESSION_SECONDS, EKS_CLUSTER_NAME, awsReadSession, awsSessionName, mintingCredentialOf, roleAccountOf,
  type ClusterIdentity, type EksCluster, type EksMintingCredential, type Minted, type MintReach,
} from '../domain/minting.ts';
import type { CredentialMinter, VaultRepository } from '../domain/ports.ts';
import { isSystemSecret, type VaultSecret } from '../domain/vault.ts';

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

/**
 * Mints an EKS token from the minting credential `name` (its value `c`) for the job `jobId`: the kubeconfig and the AWS
 * minting credential are read in the vault, never given out. `identify` (a mint test): the cluster says who the token
 * is. A refusal says why; an outside service's error is thrown, for the caller to say.
 */
export async function mintEks(
  o: { vault: Pick<VaultRepository, 'get' | 'list'>; minter: CredentialMinter; valueOf(secret: VaultSecret): Promise<{ value: string } | { refused: string }> },
  name: string, c: EksMintingCredential, jobId: string, identify?: boolean,
): Promise<EksMinted | { refused: string }> {
  const refuse = (why: string) => ({ refused: `the minting credential ${name}: ${why}` });
  let kubeconfig: string | undefined;
  if (c.kubeconfig) {
    const secret = isSystemSecret(c.kubeconfig) ? undefined : o.vault.get(c.kubeconfig);
    if (!secret) return refuse(`it names the kubeconfig ${c.kubeconfig}, and the vault holds no secret of that name`);
    const read = await o.valueOf(secret);
    if ('refused' in read) return refuse(read.refused);
    kubeconfig = read.value;
  }
  const cluster = eksClusterOf(c, kubeconfig);
  if (typeof cluster === 'string') return refuse(cluster);
  const account = roleAccountOf(c.roleArn);
  const aws = o.vault.list().find((s) => s.mints?.kind === 'aws-account' && s.mints.name === account);
  if (!aws) return refuse(`its EKS sign-in assumes ${c.roleArn}: no minting credential mints for aws-account ${account}: a person adds one on Settings → Vault`);
  const read = await o.valueOf(aws);
  if ('refused' in read) return refuse(`the AWS minting credential ${aws.name}: ${read.refused}`);
  const keys = mintingCredentialOf('aws', read.value);
  if (typeof keys === 'string') return refuse(`the AWS minting credential ${aws.name}: ${keys}`);
  const sessionName = awsSessionName(keys, jobId);
  const session = await o.minter.awsSession(keys, { roleArn: c.roleArn, sessionName, ...awsReadSession(c.roleArn), durationSeconds: AWS_SESSION_SECONDS });
  const minted = await o.minter.eksToken(session, cluster);
  const reach = { kind: 'kube' as const, server: cluster.server, ...(cluster.certificateAuthorityData ? { certificateAuthorityData: cluster.certificateAuthorityData } : {}) };
  return { minted, reach, roleArn: c.roleArn, sessionName, ...(identify ? { cluster: await o.minter.kubeIdentity(reach, minted.token) } : {}) };
}
