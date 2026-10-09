// The minting adapters (issue #580, design.md "Minting: short-lived credentials"), at the `CredentialMinter` port: STS
// AssumeRole through the AWS SDK (@aws-sdk/client-sts), and the Kubernetes TokenRequest API — one POST, sent with
// node's own https and the cluster's CA, since a Kubernetes client library would cost more than the call. Called only
// after Access allowed the mint. An error says what the outside service answered, never the minting credential.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { CredentialMinter } from '../domain/ports.ts';

const TIMEOUT_MS = 15_000;
const ANSWER_MAX = 256 * 1024;

/** POSTs `body` as JSON to `url` with a bearer token; the parsed answer, or an error naming the status. */
function postJson(url: URL, token: string, body: unknown, ca: string | undefined): Promise<unknown> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = send(url, {
      method: 'POST', timeout: TIMEOUT_MS, ...(ca ? { ca } : {}),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', 'content-length': Buffer.byteLength(payload) },
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
        reject(new Error(`the Kubernetes API answered ${status}${typeof message === 'string' ? `: ${message.slice(0, 300)}` : ''}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error(`the Kubernetes API did not answer in ${TIMEOUT_MS / 1000} s`)));
    req.on('error', (e) => reject(new Error(`the Kubernetes API could not be reached: ${e.message}`)));
    req.end(payload);
  });
}

export function createCredentialMinter(): CredentialMinter {
  return {
    async awsSession(credential, r) {
      const sts = new STSClient({
        region: credential.Region ?? 'us-east-1',
        ...(credential.Endpoint ? { endpoint: credential.Endpoint } : {}),
        credentials: { accessKeyId: credential.AccessKeyId, secretAccessKey: credential.SecretAccessKey, ...(credential.SessionToken ? { sessionToken: credential.SessionToken } : {}) },
        maxAttempts: 1,
      });
      try {
        const out = await sts.send(new AssumeRoleCommand({
          RoleArn: r.roleArn, RoleSessionName: r.sessionName, DurationSeconds: r.durationSeconds,
          ...(r.policyArns.length ? { PolicyArns: r.policyArns.map((arn) => ({ arn })) } : {}),
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

    async kubeToken(credential, r) {
      const url = new URL(`/api/v1/namespaces/${encodeURIComponent(r.namespace)}/serviceaccounts/${encodeURIComponent(r.serviceAccount)}/token`, credential.server);
      const ca = credential.certificateAuthorityData ? Buffer.from(credential.certificateAuthorityData, 'base64').toString('utf8') : undefined;
      const answer = await postJson(url, credential.token, { apiVersion: 'authentication.k8s.io/v1', kind: 'TokenRequest', spec: { expirationSeconds: r.expirationSeconds } }, ca)
        .catch((e: unknown) => { throw new Error(`a token for ${r.namespace}/${r.serviceAccount}: ${(e as Error).message}`, { cause: e }); });
      const status = (answer as { status?: { token?: unknown; expirationTimestamp?: unknown } }).status;
      if (typeof status?.token !== 'string' || typeof status.expirationTimestamp !== 'string') throw new Error(`the Kubernetes API answered no token for ${r.namespace}/${r.serviceAccount}`);
      return { kind: 'kube', token: status.token, expirationTimestamp: status.expirationTimestamp };
    },
  };
}
