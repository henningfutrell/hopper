// Minting (issue #580, design.md "Minting: short-lived credentials"): the vault mints a short-lived credential for a
// box's job — an AWS STS role session, a Kubernetes TokenRequest token — from a **minting credential**, a vault secret
// marked with the asset it mints for, only after Access (`decideMint`) allows the job's template the operation on the
// asset. The minting credential never leaves the hopper. The types every part shares, the rules that map an operation
// profile to what is minted, and the port the minting adapters sit behind. Pure.
import type { Asset, AssetKind, Operation, OperationProfile } from './access.ts';

/** What the vault mints: an AWS role session (`aws`) or a Kubernetes service account token (`kube`). Also the helper's form. */
export const MINT_KINDS = ['aws', 'kube'] as const;
export type MintKind = (typeof MINT_KINDS)[number];

/** The asset kinds a minting credential mints for: an AWS account, a Kubernetes cluster. */
export const MINTS_FOR_KINDS = ['aws-account', 'cluster'] as const satisfies readonly AssetKind[];
export type MintsForKind = (typeof MINTS_FOR_KINDS)[number];

/** How long a minted credential lives: STS's floor (15 minutes), and TokenRequest's floor (10 minutes). */
export const AWS_SESSION_SECONDS = 900;
export const KUBE_TOKEN_SECONDS = 600;
/** The session policy a read session gets: AWS's managed read-only policy, so the session reads whatever the role may do. */
export const AWS_READ_POLICY = 'arn:aws:iam::aws:policy/ReadOnlyAccess';
/** Where a token for a whole cluster is minted: the service accounts `hopper-<operation>` live in this namespace. */
export const KUBE_CLUSTER_NAMESPACE = 'hopper';

/**
 * A minting credential's value for AWS: a key pair STS takes, an optional region and endpoint (an STS other than AWS's),
 * and (issue #781) the session name it assumes a role with: a fixed `SessionName`, or a `SessionNamePrefix` before the
 * job id. Neither: `hopper-<job id>` (`awsSessionName`).
 */
export interface AwsMintingCredential {
  AccessKeyId: string; SecretAccessKey: string; SessionToken?: string; Region?: string; Endpoint?: string; SessionName?: string; SessionNamePrefix?: string;
}

/** The region the hopper asks STS in, and a check box's AWS CLI works in (issue #797): the credential's, else AWS's first. */
export const awsRegionOf = (c: Pick<AwsMintingCredential, 'Region'>): string => c.Region ?? 'us-east-1';

/** The characters STS takes in a role session name. */
const SESSION_NAME_CHARS = /^[\w+=,.@-]+$/;
/** The session name a mint for the job assumes the role with: STS takes at most 64 characters. */
export const awsSessionName = (c: AwsMintingCredential, jobId: string): string => c.SessionName ?? `${c.SessionNamePrefix ?? 'hopper-'}${jobId}`.slice(0, 64);

/** Why the credential's session name or prefix is not one STS takes, or nothing. */
function sessionNameProblem(name: string | undefined, prefix: string | undefined): string | undefined {
  const allowed = 'letters, digits and + = , . @ _ -';
  if (name !== undefined && prefix !== undefined) return 'an aws minting credential names SessionName or SessionNamePrefix, not both';
  if (name !== undefined && (name.length < 2 || name.length > 64 || !SESSION_NAME_CHARS.test(name))) return `SessionName must be 2 to 64 of ${allowed}`;
  if (prefix !== undefined && (prefix.length > 32 || !SESSION_NAME_CHARS.test(prefix))) return `SessionNamePrefix must be 1 to 32 of ${allowed}`;
  return undefined;
}
/** A minting credential's value for Kubernetes: the API server, a token allowed to create service account tokens, its CA. */
export interface KubeMintingCredential { server: string; token: string; certificateAuthorityData?: string }

/** What is minted for one profile: the AWS role and session policies, or the Kubernetes service account. */
export type MintTarget =
  | { kind: 'aws'; mintsFor: Asset; roleArn: string; policyArns: string[]; durationSeconds: number }
  | { kind: 'kube'; mintsFor: Asset; namespace: string; serviceAccount: string; expirationSeconds: number };

/**
 * What `kind` mints for the profile, or why it mints nothing for it. AWS: an `aws-role` (`<account>/<role>`) is assumed,
 * a read session under the read-only policy. Kubernetes: a `namespace` (`<cluster>/<ns>`) or a `cluster` asset gets a
 * token for the service account `hopper-<operation>` in that namespace (or `hopper` for a cluster); its RBAC is the
 * cluster's.
 */
export function mintTarget(kind: MintKind, p: OperationProfile): MintTarget | string {
  const { kind: assetKind, name } = p.asset;
  if (kind === 'aws') {
    const [account, role, ...rest] = name.split('/');
    if (assetKind !== 'aws-role' || !account || !role || rest.length) return `an aws credential is minted for an aws-role (aws-role/<account>/<role>), not ${assetKind}/${name}`;
    return { kind, mintsFor: { kind: 'aws-account', name: account }, roleArn: `arn:aws:iam::${account}:role/${role}`, policyArns: p.operation === 'read' ? [AWS_READ_POLICY] : [], durationSeconds: AWS_SESSION_SECONDS };
  }
  const serviceAccount = `hopper-${p.operation}`;
  if (assetKind === 'cluster') return { kind, mintsFor: { kind: 'cluster', name }, namespace: KUBE_CLUSTER_NAMESPACE, serviceAccount, expirationSeconds: KUBE_TOKEN_SECONDS };
  const [cluster, namespace, ...rest] = name.split('/');
  if (assetKind !== 'namespace' || !cluster || !namespace || rest.length) return `a kube credential is minted for a cluster or a namespace (cluster/<name>, namespace/<cluster>/<ns>), not ${assetKind}/${name}`;
  return { kind, mintsFor: { kind: 'cluster', name: cluster }, namespace, serviceAccount, expirationSeconds: KUBE_TOKEN_SECONDS };
}

/** A minted credential, as the helper prints it: the AWS session's key pair, or the token, each with its expiry. */
export type Minted =
  | { kind: 'aws'; AccessKeyId: string; SecretAccessKey: string; SessionToken: string; Expiration: string }
  | { kind: 'kube'; token: string; expirationTimestamp: string };

/**
 * Where a minted credential is used, from its minting credential (issue #797): for AWS the region and the STS endpoint
 * (when it is not AWS's), for Kubernetes the API server and its CA. No secret: what a read-only check box needs beside
 * the credential to reach the account or cluster.
 */
export type MintReach =
  | { kind: 'aws'; region: string; stsEndpoint?: string }
  | { kind: 'kube'; server: string; certificateAuthorityData?: string };

/** What the vault mints for read on an asset of this kind (issue #797): an AWS session for a role, a token for a cluster or a namespace; undefined: none. */
export function mintKindFor(kind: AssetKind): MintKind | undefined {
  if (kind === 'aws-role') return 'aws';
  return kind === 'cluster' || kind === 'namespace' ? 'kube' : undefined;
}

/** When a minted credential expires. */
export const expiryOf = (m: Minted): string => (m.kind === 'aws' ? m.Expiration : m.expirationTimestamp);

/**
 * The minting adapters (`src/vault/minter.ts`): STS and the Kubernetes API. A call that fails throws, saying what the
 * outside service answered; never with the minting credential in the message.
 */
export interface CredentialMinter {
  awsSession(credential: AwsMintingCredential, r: { roleArn: string; sessionName: string; policyArns: string[]; durationSeconds: number }): Promise<Extract<Minted, { kind: 'aws' }>>;
  kubeToken(credential: KubeMintingCredential, r: { namespace: string; serviceAccount: string; expirationSeconds: number }): Promise<Extract<Minted, { kind: 'kube' }>>;
  /** Who STS says the minted session is (`GetCallerIdentity`), asked at the credential's STS with the session's keys (issue #781). */
  awsCallerIdentity(credential: AwsMintingCredential, session: Extract<Minted, { kind: 'aws' }>): Promise<CallerIdentity>;
}

/** Who STS says a session is: for a minted session, the role it assumed and the session name, as `arn`. */
export interface CallerIdentity { arn: string; account: string; userId: string }

/**
 * A mint test (issue #781): the hopper mints an AWS read session for a person, as for a job, and asks STS who that
 * session is. Its session is named as a job's is, with `MINT_TEST_ID` in place of the job id.
 */
export const MINT_TEST_ID = 'mint-test';

/** A read-only check's mints (issue #797): an AWS session is named as a job's is, with this in place of the job id. */
export const CHECK_MINT_ID = 'read-only-check';

/** What a mint test answers: the role, what was asked of STS, and who STS says the session is. Never a key. */
export interface MintTestResult {
  asset: Asset; credential: string; roleArn: string; sessionName: string; durationSeconds: number; policyArns: string[]; expiresAt: string;
  identity: CallerIdentity;
}

/** The minting credential's value read as `kind` wants it, or why it cannot be. Never says the value. */
export function mintingCredentialOf(kind: 'aws', value: string): AwsMintingCredential | string;
export function mintingCredentialOf(kind: 'kube', value: string): KubeMintingCredential | string;
export function mintingCredentialOf(kind: MintKind, value: string): AwsMintingCredential | KubeMintingCredential | string {
  let v: Record<string, unknown> = {};
  try { v = JSON.parse(value) as Record<string, unknown>; } catch { /* below */ }
  const str = (k: string): string | undefined => (typeof v[k] === 'string' && v[k] !== '' ? v[k] : undefined);
  if (kind === 'aws') {
    const AccessKeyId = str('AccessKeyId');
    const SecretAccessKey = str('SecretAccessKey');
    if (!AccessKeyId || !SecretAccessKey) return 'an aws minting credential holds JSON with AccessKeyId and SecretAccessKey (and SessionToken, Region, Endpoint, SessionName or SessionNamePrefix when it has them)';
    const problem = sessionNameProblem(str('SessionName'), str('SessionNamePrefix'));
    if (problem) return problem;
    const extra = (['SessionToken', 'Region', 'Endpoint', 'SessionName', 'SessionNamePrefix'] as const).flatMap((k) => (str(k) ? [[k, str(k)!]] : []));
    return { AccessKeyId, SecretAccessKey, ...Object.fromEntries(extra) };
  }
  const server = str('server');
  const token = str('token');
  if (!server || !token || !/^https?:\/\//.test(server)) return 'a kube minting credential holds JSON with server (its URL) and token (and certificateAuthorityData when the server has its own CA)';
  return { server, token, ...(str('certificateAuthorityData') ? { certificateAuthorityData: str('certificateAuthorityData')! } : {}) };
}

/** A minting credential's asset said in a request: `{kind, name}` of a kind a credential mints for, or why not. */
export function mintsForProblem(a: { kind: string; name: string }): string | undefined {
  if (!(MINTS_FOR_KINDS as readonly string[]).includes(a.kind)) return `a minting credential mints for ${MINTS_FOR_KINDS.join(' or ')}, not ${a.kind}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._+=,-]{0,199}$/.test(a.name)) return `${a.kind} ${JSON.stringify(a.name)} is not a name a minting credential mints for (letters, digits and . _ + = , -)`;
  return undefined;
}

/** `read` on `namespace lab/web`: a profile in words. */
export const profileInWords = (p: { operation: Operation; asset: Asset }): string => `${p.operation} on ${p.asset.kind} ${p.asset.name}`;
