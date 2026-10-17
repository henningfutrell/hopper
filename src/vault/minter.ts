// The minting adapters (issue #580, design.md "Minting: short-lived credentials"), at the `CredentialMinter` port: STS
// AssumeRole (and, for a mint test, issue #781, GetCallerIdentity) through the AWS SDK (@aws-sdk/client-sts), the EKS
// token (issue #854) presigned by the AWS SDK's own signer (@smithy/signature-v4), and the Kubernetes API — a
// TokenRequest, and for a mint test a SelfSubjectReview and the namespace list —, each one call sent with node's own
// https and the cluster's CA, since a Kubernetes client library would cost more than the calls. A discovered cluster
// (issue #1766) is described by EKS through the AWS SDK (@aws-sdk/client-eks). A sandbox's token
// (issue #1371) is bound to a Secret the minter makes for it, and deleting that Secret ends the token at once. Called
// only after Access allowed the mint. An error says what the outside service answered, never the minting credential.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { DescribeClusterCommand, EKSClient, ResourceNotFoundException } from '@aws-sdk/client-eks';
import { HttpRequest } from '@smithy/core/protocols';
import { Hash } from '@smithy/core/serde';
import { SignatureV4 } from '@smithy/signature-v4';
import { awsRegionOf, EKS_TOKEN_SECONDS, MINT_BINDING_LABEL, type AwsMintingCredential, type KubeTokenCredential } from '../domain/minting.ts';
import type { CredentialMinter } from '../domain/ports.ts';

const TIMEOUT_MS = 15_000;
const ANSWER_MAX = 256 * 1024;

/** What the Kubernetes API answered when it was not a success: its status, for a caller that takes a 404 as gone. */
class KubeApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Sends `body` (none: a GET, or `method`) as JSON to `url` with a bearer token; the parsed answer, or an error naming the status. */
function callJson(url: URL, token: string, body: unknown, ca: string | undefined, method?: 'DELETE'): Promise<unknown> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = send(url, {
      method: method ?? (body === undefined ? 'GET' : 'POST'), timeout: TIMEOUT_MS, ...(ca ? { ca } : {}),
      headers: {
        authorization: `Bearer ${token}`, accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { if (text.length < ANSWER_MAX) text += c; });
      res.on('end', () => {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = undefined; }
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300 && parsed !== undefined) return resolve(parsed);
        const message = (parsed as { message?: unknown } | undefined)?.message;
        reject(new KubeApiError(`the Kubernetes API answered ${status}${typeof message === 'string' ? `: ${message.slice(0, 300)}` : ''}`, status));
      });
    });
    req.on('timeout', () => req.destroy(new Error(`the Kubernetes API did not answer in ${TIMEOUT_MS / 1000} s`)));
    req.on('error', (e) => reject(new Error(`the Kubernetes API could not be reached: ${e.message}`)));
    req.end(payload);
  });
}

/** A base64 CA as PEM, for node's https. */
const pemOf = (ca: string | undefined): string | undefined => (ca ? Buffer.from(ca, 'base64').toString('utf8') : undefined);

/** Makes the Secret `name` a sandbox's token is bound to (issue #1371): labelled, empty, and only the hopper's. Its uid. */
async function makeBinding(credential: KubeTokenCredential, namespace: string, name: string, ca: string | undefined): Promise<{ name: string; uid: string }> {
  const url = new URL(`/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`, credential.server);
  const answer = await callJson(url, credential.token, { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { name, labels: { [MINT_BINDING_LABEL]: 'true' } } }, ca)
    .catch((e: unknown) => { throw new Error(`the Secret ${namespace}/${name} to bind the token to (the minting credential needs create and delete on secrets in ${namespace}): ${(e as Error).message}`, { cause: e }); });
  const uid = (answer as { metadata?: { uid?: unknown } }).metadata?.uid;
  if (typeof uid !== 'string') throw new Error(`the Kubernetes API answered no uid for the Secret ${namespace}/${name}`);
  return { name, uid };
}

/** Deletes the Secret `name`; one already gone (404) is no error. */
async function deleteSecret(credential: KubeTokenCredential, namespace: string, name: string, ca: string | undefined): Promise<void> {
  const url = new URL(`/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`, credential.server);
  await callJson(url, credential.token, undefined, ca, 'DELETE').catch((e: unknown) => {
    if (e instanceof KubeApiError && e.status === 404) return;
    throw e;
  });
}

/** STS's host in the region: the China partition has its own domain. */
const stsHost = (region: string): string => `sts.${region}.${region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}`;

/** The EKS token: GetCallerIdentity presigned with the session, the cluster's name in a signed header (issue #854). */
async function eksToken(session: { AccessKeyId: string; SecretAccessKey: string; SessionToken: string; Expiration: string }, r: { cluster: string; region: string }) {
  const hostname = stsHost(r.region);
  const signer = new SignatureV4({
    service: 'sts', region: r.region, sha256: Hash.bind(null, 'sha256'),
    credentials: { accessKeyId: session.AccessKeyId, secretAccessKey: session.SecretAccessKey, sessionToken: session.SessionToken },
  });
  const signedAt = new Date();
  // EKS takes the URL for 15 minutes from its signing whatever X-Amz-Expires says; `aws eks get-token` signs 60.
  const signed = await signer.presign(new HttpRequest({
    method: 'GET', protocol: 'https:', hostname, path: '/', headers: { host: hostname, 'x-k8s-aws-id': r.cluster },
    query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
  }), { expiresIn: 60, signingDate: signedAt });
  const query = new URLSearchParams(signed.query as Record<string, string>).toString();
  const token = `k8s-aws-v1.${Buffer.from(`https://${hostname}/?${query}`).toString('base64url')}`;
  const expires = Math.min(signedAt.getTime() + EKS_TOKEN_SECONDS * 1000, Date.parse(session.Expiration));
  return { kind: 'kube' as const, token, expirationTimestamp: new Date(expires).toISOString() };
}

/** An STS client at the minting credential's region and endpoint, signing with `keys`. */
const stsAt = (credential: AwsMintingCredential, keys: { AccessKeyId: string; SecretAccessKey: string; SessionToken?: string | undefined }): STSClient => new STSClient({
  region: awsRegionOf(credential),
  ...(credential.Endpoint ? { endpoint: credential.Endpoint } : {}),
  credentials: { accessKeyId: keys.AccessKeyId, secretAccessKey: keys.SecretAccessKey, ...(keys.SessionToken ? { sessionToken: keys.SessionToken } : {}) },
  maxAttempts: 1,
});

export function createCredentialMinter(): CredentialMinter {
  return {
    async awsSession(credential, r) {
      const sts = stsAt(credential, credential);
      try {
        const out = await sts.send(new AssumeRoleCommand({
          RoleArn: r.roleArn, RoleSessionName: r.sessionName, DurationSeconds: r.durationSeconds,
          ...(r.policyArns.length ? { PolicyArns: r.policyArns.map((arn) => ({ arn })) } : {}),
          ...(r.policy ? { Policy: r.policy } : {}),
        }));
        const c = out.Credentials;
        if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) throw new Error('STS answered no credentials');
        return { kind: 'aws', AccessKeyId: c.AccessKeyId, SecretAccessKey: c.SecretAccessKey, SessionToken: c.SessionToken, Expiration: c.Expiration.toISOString() };
      } catch (e) {
        throw new Error(`STS refused AssumeRole on ${r.roleArn}: ${(e as Error).message}`, { cause: e });
      } finally {
        sts.destroy();
      }
    },

    async awsCallerIdentity(credential, session) {
      const sts = stsAt(credential, session);
      try {
        const out = await sts.send(new GetCallerIdentityCommand({}));
        if (!out.Arn || !out.Account || !out.UserId) throw new Error('STS answered no identity');
        return { arn: out.Arn, account: out.Account, userId: out.UserId };
      } catch (e) {
        throw new Error(`STS refused GetCallerIdentity with the minted session: ${(e as Error).message}`, { cause: e });
      } finally {
        sts.destroy();
      }
    },

    async kubeToken(credential, r) {
      const ca = pemOf(credential.certificateAuthorityData);
      // A sandbox's token (issue #1371): bound to a Secret of its own in the service account's namespace.
      const bound = r.bindTo ? await makeBinding(credential, r.namespace, r.bindTo, ca) : undefined;
      const url = new URL(`/api/v1/namespaces/${encodeURIComponent(r.namespace)}/serviceaccounts/${encodeURIComponent(r.serviceAccount)}/token`, credential.server);
      const spec = { expirationSeconds: r.expirationSeconds, ...(bound ? { boundObjectRef: { apiVersion: 'v1', kind: 'Secret', name: bound.name, uid: bound.uid } } : {}) };
      try {
        const answer = await callJson(url, credential.token, { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest', spec }, ca)
          .catch((e: unknown) => { throw new Error(`a token for ${r.namespace}/${r.serviceAccount}: ${(e as Error).message}`, { cause: e }); });
        const status = (answer as { status?: { token?: unknown; expirationTimestamp?: unknown } }).status;
        if (typeof status?.token !== 'string' || typeof status.expirationTimestamp !== 'string') throw new Error(`the Kubernetes API answered no token for ${r.namespace}/${r.serviceAccount}`);
        return { kind: 'kube', token: status.token, expirationTimestamp: status.expirationTimestamp };
      } catch (e) {
        // No token: its Secret goes too, so no binding is left that nothing records.
        if (bound) await deleteSecret(credential, r.namespace, bound.name, ca).catch(() => {});
        throw e;
      }
    },

    async kubeUnbind(credential, r) {
      await deleteSecret(credential, r.namespace, r.secret, pemOf(credential.certificateAuthorityData))
        .catch((e: unknown) => { throw new Error(`the Secret ${r.namespace}/${r.secret} a token is bound to: ${(e as Error).message}`, { cause: e }); });
    },

    eksToken,

    async eksCluster(session, r) {
      const eks = new EKSClient({
        region: r.region, ...(r.endpoint ? { endpoint: r.endpoint } : {}), maxAttempts: 1,
        credentials: { accessKeyId: session.AccessKeyId, secretAccessKey: session.SecretAccessKey, sessionToken: session.SessionToken },
      });
      try {
        const c = (await eks.send(new DescribeClusterCommand({ name: r.cluster }))).cluster;
        if (!c?.endpoint) throw new Error(`EKS answered no API server for ${r.cluster}`);
        const ca = c.certificateAuthority?.data;
        return { cluster: r.cluster, region: r.region, server: c.endpoint, ...(ca ? { certificateAuthorityData: ca } : {}) };
      } catch (e) {
        if (e instanceof ResourceNotFoundException) return undefined;
        throw new Error(`EKS refused DescribeCluster on ${r.cluster} in ${r.region}: ${(e as Error).message}`, { cause: e });
      } finally {
        eks.destroy();
      }
    },

    async kubeIdentity(reach, token) {
      const ca = pemOf(reach.certificateAuthorityData);
      const review = await callJson(new URL('/apis/authentication.k8s.io/v1/selfsubjectreviews', reach.server), token, { apiVersion: 'authentication.k8s.io/v1', kind: 'SelfSubjectReview' }, ca)
        .catch((e: unknown) => { throw new Error(`who the token is (kubectl auth whoami): ${(e as Error).message}`, { cause: e }); });
      const info = (review as { status?: { userInfo?: { username?: unknown; groups?: unknown } } }).status?.userInfo;
      if (typeof info?.username !== 'string') throw new Error('the Kubernetes API answered no user for the token');
      const groups = Array.isArray(info.groups) ? info.groups.filter((g): g is string => typeof g === 'string') : [];
      const list = await callJson(new URL('/api/v1/namespaces', reach.server), token, undefined, ca)
        .catch((e: unknown) => { throw new Error(`the namespaces (kubectl get ns) as ${info.username as string}: ${(e as Error).message}`, { cause: e }); });
      const items = (list as { items?: { metadata?: { name?: unknown } }[] }).items ?? [];
      return { user: { username: info.username, groups }, namespaces: items.flatMap((n) => (typeof n.metadata?.name === 'string' ? [n.metadata.name] : [])) };
    },
  };
}
