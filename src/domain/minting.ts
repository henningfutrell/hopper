// Minting (issue #580, design.md "Minting: short-lived credentials"): the vault mints a short-lived credential for a
// box's job — an AWS STS role session, a Kubernetes TokenRequest token — from a **minting credential**, a vault secret
// marked with the asset it mints for, only after Access (`decideMint`) allows the job's template the operation on the
// asset. The minting credential never leaves the hopper. The types every part shares, the rules that map an operation
// profile to what is minted, and the port the minting adapters sit behind. Pure.
import type { Asset, AssetKind, Operation, OperationProfile } from './access.ts';
import type { AwsAction } from './action-grants.ts';
import { databaseCredentialOf, databaseNameProblem } from './database-read.ts';

/** What the vault mints: an AWS role session (`aws`) or a Kubernetes service account token (`kube`). Also the helper's form. */
export const MINT_KINDS = ['aws', 'kube'] as const;
export type MintKind = (typeof MINT_KINDS)[number];

/** The asset kinds a minting credential mints for: an AWS account, a Kubernetes cluster, a database (issue #2231: its read roles). */
export const MINTS_FOR_KINDS = ['aws-account', 'cluster', 'database'] as const satisfies readonly AssetKind[];
export type MintsForKind = (typeof MINTS_FOR_KINDS)[number];

/** How long a minted credential lives: STS's floor (15 minutes), and TokenRequest's floor (10 minutes). */
export const AWS_SESSION_SECONDS = 900;
export const KUBE_TOKEN_SECONDS = 600;
/**
 * How long an EKS token lives (issue #854): EKS takes a presigned URL for 15 minutes from its signing; the hopper says
 * 14, as `aws eks get-token` does, so kubectl asks again before EKS refuses it.
 */
export const EKS_TOKEN_SECONDS = 840;
/** The session policy a read session gets: AWS's managed read-only policy, so the session reads whatever the role may do. */
export const AWS_READ_POLICY = 'arn:aws:iam::aws:policy/ReadOnlyAccess';
/**
 * The write actions a read session is denied (issues #715, #853), by name, in the services an infra read touches most.
 * IAM takes no wildcard in a service prefix (`*:Create*` makes STS refuse the whole AssumeRole), so each service is
 * named, and STS takes at most 2048 characters of inline session policy, so the list is short. The cap on every other
 * service is `ReadOnlyAccess`: a session gets only what both the role and its session policies allow. IAM's own writes
 * that do not start with one of the verbs are named beside them.
 */
const WRITE_VERBS = ['Create*', 'Delete*', 'Put*', 'Update*', 'Modify*'];
const WRITE_DENIED_SERVICES = ['iam', 's3', 'dynamodb', 'ec2', 'ssm', 'rds', 'lambda', 'ecs', 'eks', 'kms', 'secretsmanager', 'cloudformation'];
const DENIED_WRITES = [
  ...WRITE_DENIED_SERVICES.flatMap((service) => WRITE_VERBS.map((verb) => `${service}:${verb}`)),
  'iam:Add*', 'iam:Attach*', 'iam:Change*', 'iam:Deactivate*', 'iam:Detach*', 'iam:Enable*', 'iam:PassRole', 'iam:Remove*',
  'iam:Reset*', 'iam:Resync*', 'iam:Set*', 'iam:Tag*', 'iam:Untag*', 'iam:Upload*',
];

/**
 * The inline session policy a read session gets beside `ReadOnlyAccess` (issue #715): explicit denies only — an allow
 * here could add to what the managed policy gives. It denies every write above, and assuming any role but its own.
 */
export const awsReadDenyPolicy = (roleArn: string): string => JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    { Sid: 'HopperReadNoWrites', Effect: 'Deny', Action: DENIED_WRITES, Resource: '*' },
    { Sid: 'HopperReadNoOtherRole', Effect: 'Deny', Action: ['sts:AssumeRole', 'sts:AssumeRoleWithSAML', 'sts:AssumeRoleWithWebIdentity'], NotResource: roleArn },
  ],
});
/** The session policies a read session of `roleArn` gets: `ReadOnlyAccess`, and the deny policy beside it. */
export const awsReadSession = (roleArn: string): { policyArns: string[]; policy: string } => ({ policyArns: [AWS_READ_POLICY], policy: awsReadDenyPolicy(roleArn) });

/** The role an operator makes for granted actions (issue #2206): a change on it is minted only narrowed to them. */
export const ACTION_ROLE = 'hopper-action';
/** The most characters of inline session policy STS takes. */
export const SESSION_POLICY_MAX = 2048;

/**
 * The session policies of a step's change on `roleArn` narrowed to granted `actions`: `ReadOnlyAccess`, and an inline
 * policy that allows each action on its resource and denies assuming any other role; or why STS would refuse it.
 */
export function actionSession(roleArn: string, actions: readonly AwsAction[]): { policyArns: string[]; policy: string } | string {
  const policy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      ...actions.map((a, i) => ({ Sid: `HopperGranted${i}`, Effect: 'Allow', Action: a.action, Resource: a.resource })),
      { Sid: 'HopperGrantedNoOtherRole', Effect: 'Deny', Action: ['sts:AssumeRole', 'sts:AssumeRoleWithSAML', 'sts:AssumeRoleWithWebIdentity'], NotResource: roleArn },
    ],
  });
  if (policy.length > SESSION_POLICY_MAX) return `the session policy for these actions is ${policy.length} characters, more than the ${SESSION_POLICY_MAX} STS takes: name fewer actions in one step`;
  return { policyArns: [AWS_READ_POLICY], policy };
}

/** Where a token for a whole cluster is minted: the service accounts `hopper-<operation>` live in this namespace. */
export const KUBE_CLUSTER_NAMESPACE = 'hopper';
/** Where a sync of an Argo CD app is minted (issue #959): Argo CD's namespace, where its Applications live. */
export const ARGOCD_NAMESPACE = 'argocd';

/**
 * A minting credential's value for AWS: a key pair STS takes, an optional region and endpoint (an STS other than AWS's),
 * and (issue #781) the session name it assumes a role with: a fixed `SessionName`, or a `SessionNamePrefix` before the
 * job id. Neither: `hopper-<job id>` (`awsSessionName`). `EksEndpoint` (issue #1766): the EKS a discovery asks, when
 * it is not AWS's; a credential whose STS is not AWS's asks no EKS without it.
 */
export interface AwsMintingCredential {
  AccessKeyId: string; SecretAccessKey: string; SessionToken?: string; Region?: string; Endpoint?: string; EksEndpoint?: string; SessionName?: string; SessionNamePrefix?: string;
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
/**
 * A minting credential's value for Kubernetes: a `token` credential — the API server, a token allowed to create service
 * account tokens, its CA; its value names no `type` — or (issue #854) an `eks` credential, which signs in through EKS.
 */
export type KubeMintingCredential = KubeTokenCredential | EksMintingCredential;
export interface KubeTokenCredential { type: 'token'; server: string; token: string; certificateAuthorityData?: string }

/**
 * EKS sign-in (issue #854): the vault mints a read session of the IAM role `roleArn` from the AWS minting credential for
 * the role's account, and signs an EKS token with it. The cluster is named here (`cluster`, `region`, `server`,
 * `certificateAuthorityData`), or found in the vault secret `kubeconfig` (its `context`, else its current one), whose
 * EKS exec sign-in names the cluster; a field named here wins. The role's access entry or aws-auth mapping in the
 * cluster decides what the token may do: the hopper never changes the cluster.
 */
export interface EksMintingCredential {
  type: 'eks'; roleArn: string; cluster?: string; region?: string; server?: string; certificateAuthorityData?: string; kubeconfig?: string; context?: string;
}

/** The EKS cluster a token is signed for and a kubeconfig reaches. */
export interface EksCluster { cluster: string; region: string; server: string; certificateAuthorityData?: string }

/** An IAM role's ARN, in any partition: its account is group 1. A path may come before the role's name. */
const ROLE_ARN = /^arn:aws[a-z-]*:iam::(\d{12}):role\/[\w+=,.@/-]{1,512}$/;

/** The account of an IAM role's ARN. */
export const roleAccountOf = (roleArn: string): string => ROLE_ARN.exec(roleArn)?.[1] ?? '';

/** A cluster's name as EKS takes it, and a region's. */
export const EKS_CLUSTER_NAME = /^[0-9A-Za-z][A-Za-z0-9_-]{0,99}$/;
export const AWS_REGION_NAME = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;

/** What is minted for one profile: the AWS role and session policies, or the Kubernetes service account. */
export type MintTarget =
  | { kind: 'aws'; mintsFor: Asset; roleArn: string; policyArns: string[]; policy?: string; durationSeconds: number }
  | { kind: 'kube'; mintsFor: Asset; namespace: string; serviceAccount: string; expirationSeconds: number; bindTo?: string };

/**
 * A sandbox's Kubernetes token bound to a Secret of its own (issue #1371, design.md "Sandboxes are fresh and leave
 * nothing" part 7): the minting credential that made it, and the Secret in the service account's namespace. When the
 * Secret is deleted, the API server refuses the token once its token cache lets it go (10 s by default).
 */
export interface MintBinding { credential: string; namespace: string; secret: string }

/** The label on each Secret a sandbox's token is bound to: the hopper makes and deletes only these. */
export const MINT_BINDING_LABEL = 'io.hopper.mint';

/**
 * What `kind` mints for the profile, or why it mints nothing for it. AWS: an `aws-role` (`<account>/<role>`) is assumed,
 * a read session under the read-only policy and the deny policy (issue #715). Kubernetes: a `namespace` (`<cluster>/<ns>`) or a `cluster` asset gets a
 * token for the service account `hopper-<operation>` in that namespace (or `hopper` for a cluster); its RBAC is the
 * cluster's. An `argocd-app` (`<cluster>/<app>`, issue #959) takes sync only: `hopper-sync` in Argo CD's namespace.
 * Observe (issue #2146) is a cluster's or a namespace's only: `hopper-observe`, whose RBAC adds port-forward to view.
 */
export function mintTarget(kind: MintKind, p: OperationProfile, actions?: readonly AwsAction[]): MintTarget | string {
  const { kind: assetKind, name } = p.asset;
  if (actions?.length && (kind !== 'aws' || p.operation === 'read')) return `granted actions narrow a change on an aws-role only, not ${p.operation} on ${assetKind}/${name}`;
  if (kind === 'aws') {
    if (p.operation === 'observe') return `observe is minted for a cluster or a namespace only, not ${assetKind}/${name}: it port-forwards to their pods`;
    const [account, role, ...rest] = name.split('/');
    if (assetKind !== 'aws-role' || !account || !role || rest.length) return `an aws credential is minted for an aws-role (aws-role/<account>/<role>), not ${assetKind}/${name}`;
    const roleArn = `arn:aws:iam::${account}:role/${role}`;
    // Issue #2206: a change narrowed to the granted actions; the action role is never minted wider.
    if (role === ACTION_ROLE && p.operation !== 'read' && !actions?.length) return `the vault mints ${p.operation} on aws-role ${name} only narrowed to actions a person granted: a need step names each with --action`;
    const session = p.operation === 'read' ? awsReadSession(roleArn) : actions?.length ? actionSession(roleArn, actions) : { policyArns: [] };
    if (typeof session === 'string') return session;
    return { kind, mintsFor: { kind: 'aws-account', name: account }, roleArn, ...session, durationSeconds: AWS_SESSION_SECONDS };
  }
  const serviceAccount = `hopper-${p.operation}`;
  if (assetKind === 'argocd-app') {
    // A sync sets the Application's operation; Argo CD's controller then applies what git says (issue #959).
    if (p.operation !== 'sync') return `an argocd-app takes sync only, not ${p.operation}: read or change what it deploys on its cluster or namespace`;
    const [cluster, app, ...rest] = name.split('/');
    if (!cluster || !app || rest.length) return `a sync of an Argo CD app names its cluster (argocd-app/<cluster>/<app>), not argocd-app/${name}`;
    return { kind, mintsFor: { kind: 'cluster', name: cluster }, namespace: ARGOCD_NAMESPACE, serviceAccount, expirationSeconds: KUBE_TOKEN_SECONDS };
  }
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
  awsSession(credential: AwsMintingCredential, r: { roleArn: string; sessionName: string; policyArns: string[]; policy?: string | undefined; durationSeconds: number }): Promise<Extract<Minted, { kind: 'aws' }>>;
  /**
   * A TokenRequest token. `bindTo` (issue #1371): first a Secret of that name is made in the namespace, and the token is
   * bound to it, so it stops working when the Secret is deleted (`kubeUnbind`).
   */
  kubeToken(credential: KubeTokenCredential, r: { namespace: string; serviceAccount: string; expirationSeconds: number; bindTo?: string }): Promise<Extract<Minted, { kind: 'kube' }>>;
  /** Deletes the Secret a token is bound to (issue #1371): the token stops working. One already gone is no error. */
  kubeUnbind(credential: KubeTokenCredential, r: { namespace: string; secret: string }): Promise<void>;
  /**
   * An EKS token for `cluster` (issue #854): STS `GetCallerIdentity` presigned with `session` at the region's STS, the
   * cluster's name signed in the `x-k8s-aws-id` header, as `k8s-aws-v1.` and the URL in base64url. No call is made.
   */
  eksToken(session: Extract<Minted, { kind: 'aws' }>, r: { cluster: string; region: string }): Promise<Extract<Minted, { kind: 'kube' }>>;
  /**
   * The EKS cluster `cluster` as EKS in `region` describes it to `session` (issue #1766, `DescribeCluster`): its API
   * server and CA. Undefined when the session's account has no cluster of that name. `endpoint`: an EKS other than AWS's.
   */
  eksCluster(session: Extract<Minted, { kind: 'aws' }>, r: { cluster: string; region: string; endpoint?: string }): Promise<EksCluster | undefined>;
  /**
   * The regions the session's account `account` has enabled, as EC2 in `region` lists them to `session` (issue #1845,
   * `DescribeRegions`): where a discovery looks for a cluster. Kept for the account a while, as they seldom change.
   * `endpoint`: an EC2 other than AWS's.
   */
  awsRegions(session: Extract<Minted, { kind: 'aws' }>, r: { account: string; region: string; endpoint?: string }): Promise<string[]>;
  /** Who the cluster says `token` is (a SelfSubjectReview: `kubectl auth whoami`), and the namespaces it lists with it (issue #854). */
  kubeIdentity(reach: Extract<MintReach, { kind: 'kube' }>, token: string): Promise<ClusterIdentity>;
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

/** Who a cluster says a token is, and the namespaces it lists with it (issue #854): `kubectl auth whoami`, `kubectl get ns`. */
export interface ClusterIdentity { user: { username: string; groups: string[] }; namespaces: string[] }

/**
 * What a mint test answers. AWS: the role, what was asked of STS, and who STS says the session is. A cluster (issue
 * #854): its API server, who it says the token is and its namespaces; for EKS sign-in, the role, its account and the
 * session name. `credential` (issue #1766): the minting credential the test used, the AWS one for a discovered cluster.
 * `region`, `searched` and `warning` (issue #1845): where a discovered cluster is, where the vault looked, and why.
 * Never a key or a token.
 */
export type MintTestResult =
  | { kind: 'aws'; asset: Asset; credential: string; roleArn: string; sessionName: string; durationSeconds: number; policyArns: string[]; expiresAt: string; identity: CallerIdentity }
  | ({
    kind: 'kube'; asset: Asset; credential: string; server: string; expiresAt: string; roleArn?: string; account?: string; sessionName?: string;
    /** A discovered cluster (issue #1845): the region EKS has it in, where the vault looked, and why it passed over the cluster's own credential. */
    region?: string; searched?: { account: string; regions: string[] }[]; warning?: string;
  } & ClusterIdentity);

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
    if (!AccessKeyId || !SecretAccessKey) return 'an aws minting credential holds JSON with AccessKeyId and SecretAccessKey (and SessionToken, Region, Endpoint, EksEndpoint, SessionName or SessionNamePrefix when it has them)';
    const problem = sessionNameProblem(str('SessionName'), str('SessionNamePrefix'));
    if (problem) return problem;
    const extra = (['SessionToken', 'Region', 'Endpoint', 'EksEndpoint', 'SessionName', 'SessionNamePrefix'] as const).flatMap((k) => (str(k) ? [[k, str(k)!]] : []));
    return { AccessKeyId, SecretAccessKey, ...Object.fromEntries(extra) };
  }
  const ca = str('certificateAuthorityData') ? { certificateAuthorityData: str('certificateAuthorityData')! } : {};
  const type = str('type') ?? 'token';
  if (type === 'eks') return eksCredentialOf(str, ca);
  if (type !== 'token') return 'a kube minting credential\'s type is token or eks';
  const server = str('server');
  const token = str('token');
  if (!server || !token || !/^https?:\/\//.test(server)) return 'a kube minting credential holds JSON with server (its URL) and token (and certificateAuthorityData when the server has its own CA)';
  return { type: 'token', server, token, ...ca };
}

/** An `eks` kube minting credential (issue #854), or why its value is not one. */
function eksCredentialOf(str: (k: string) => string | undefined, ca: { certificateAuthorityData?: string }): EksMintingCredential | string {
  const roleArn = str('roleArn');
  if (!roleArn || !ROLE_ARN.test(roleArn)) return 'an eks minting credential names roleArn, the IAM role it signs in as (arn:aws:iam::<account>:role/<name>)';
  const named = Object.fromEntries((['cluster', 'region', 'server', 'kubeconfig', 'context'] as const).flatMap((k) => (str(k) ? [[k, str(k)!]] : []))) as Partial<EksMintingCredential>;
  const { cluster, region, server } = named;
  const whole = cluster && region && server;
  if (!named.kubeconfig && !whole) return 'an eks minting credential names cluster, region and server, or kubeconfig (a vault secret whose EKS sign-in names them)';
  if (server && !/^https?:\/\//.test(server)) return 'an eks minting credential names cluster, region and server, or kubeconfig: server is its URL';
  if (cluster && !EKS_CLUSTER_NAME.test(cluster)) return `an eks minting credential's cluster ${JSON.stringify(cluster)} is no EKS cluster name`;
  if (region && !AWS_REGION_NAME.test(region)) return `an eks minting credential's region ${JSON.stringify(region)} is no AWS region`;
  return { type: 'eks', roleArn, ...named, ...ca };
}

/**
 * The one secret that mints for `mintsFor` (issue #1761), or why there is none: no secret mints for it, or several do.
 * The vault never picks one of several: a mint from the wrong one fails, and says nothing of the others.
 */
export function mintingCredentialFor<S extends { name: string; mints?: Asset }>(secrets: readonly S[], mintsFor: Asset): S | string {
  const all = secrets.filter((s) => s.mints?.kind === mintsFor.kind && s.mints.name === mintsFor.name);
  if (all.length === 1) return all[0]!;
  const what = `${mintsFor.kind} ${mintsFor.name}`;
  if (all.length === 0) return `no minting credential mints for ${what}: a person adds one on Vault`;
  return `${all.length} minting credentials mint for ${what}: ${all.map((s) => s.name).join(', ')}. The vault does not pick one: a person keeps one on Vault and clears Mints for on the others`;
}

/**
 * Why `value` is no minting credential for `mints`, as a save checks it (issue #1761): an AWS account's keys are one JSON
 * value, never a secret each; so is a database's (issue #2231). A cluster's is not checked here: its EKS sign-in may name a kubeconfig the vault reads later.
 */
export function mintingValueProblem(mints: Asset, value: string): string | undefined {
  if (mints.kind === 'database') {
    const d = databaseCredentialOf(value);
    return typeof d === 'string' ? `mints for database ${mints.name}: ${d}` : undefined;
  }
  if (mints.kind !== 'aws-account') return undefined;
  const c = mintingCredentialOf('aws', value);
  return typeof c === 'string' ? `mints for aws-account ${mints.name}: ${c}` : undefined;
}

/** A minting credential's asset said in a request: `{kind, name}` of a kind a credential mints for, or why not. */
export function mintsForProblem(a: { kind: string; name: string }): string | undefined {
  if (!(MINTS_FOR_KINDS as readonly string[]).includes(a.kind)) return `a minting credential mints for ${MINTS_FOR_KINDS.join(' or ')}, not ${a.kind}`;
  if (a.kind === 'database') return databaseNameProblem(a.name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+=,-]{0,199}$/.test(a.name)) return `${a.kind} ${JSON.stringify(a.name)} is not a name a minting credential mints for (letters, digits and . _ + = , -)`;
  return undefined;
}

/** `read` on `namespace lab/web`: a profile in words. */
export const profileInWords = (p: { operation: Operation; asset: Asset }): string => `${p.operation} on ${p.asset.kind} ${p.asset.name}`;
