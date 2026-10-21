// An STS and a Kubernetes API faked on loopback (issue #797): what the vault's real minting adapters call. STS answers
// every AssumeRole with the session `MINTED_AWS`; the Kubernetes API answers every TokenRequest with `MINTED_KUBE_TOKEN`,
// and (issue #854, a mint test) a SelfSubjectReview with `KUBE_USER` and a namespace list with `KUBE_NAMESPACES`; it makes
// and deletes the Secret a sandbox's token is bound to (issue #1371), with a uid.
// Each keeps every request it got, so a test sees what was asked, or that nothing was.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export const MINTED_AWS = { AccessKeyId: 'ASIAMINTEDCHECK', SecretAccessKey: 'minted-check-secret', SessionToken: 'minted-check-session' };
export const MINTED_KUBE_TOKEN = 'minted-check-kube-token';
export const KUBE_USER = { username: 'arn:aws:sts::123456789012:assumed-role/eks-view/hopper', groups: ['hopper:view', 'system:authenticated'] };
export const KUBE_NAMESPACES = ['default', 'kube-system', 'shop'];
const EXPIRES = '2030-01-01T00:10:00Z';

export interface Seen { method: string; url: string; authorization?: string; body: string }
export interface FakeApi { url: string; seen: Seen[]; close(): void }

async function fakeServer(answer: (r: Seen) => { status: number; type: string; body: string }): Promise<FakeApi> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { body += c; });
    req.on('end', () => {
      const r: Seen = { method: req.method ?? '', url: req.url ?? '', body, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) };
      seen.push(r);
      const a = answer(r);
      res.writeHead(a.status, { 'content-type': a.type }).end(a.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => { server.close(); } };
}

/**
 * A Kubernetes API server that answers every TokenRequest, `kubectl auth whoami` and `kubectl get ns`, and makes and
 * deletes Secrets (a mint binding's); `forbid`: whoami and the namespace list 403.
 */
export const fakeKubeApi = (o: { forbid?: boolean } = {}): Promise<FakeApi> => {
  const secrets = new Set<string>();
  return fakeServer((r) => {
    const json = (status: number, body: unknown) => ({ status, type: 'application/json', body: JSON.stringify(body) });
    const secret = /^\/api\/v1\/namespaces\/([^/]+)\/secrets(?:\/([^/]+))?$/.exec(r.url);
    if (secret && r.method === 'POST') {
      const name = (JSON.parse(r.body || '{}') as { metadata?: { name?: string } }).metadata?.name ?? '';
      secrets.add(`${secret[1]}/${name}`);
      return json(201, { kind: 'Secret', metadata: { name, namespace: secret[1], uid: randomUUID() } });
    }
    if (secret && r.method === 'DELETE') {
      const key = `${secret[1]}/${decodeURIComponent(secret[2] ?? '')}`;
      return secrets.delete(key) ? json(200, { kind: 'Status', status: 'Success' }) : json(404, { kind: 'Status', status: 'Failure', reason: 'NotFound' });
    }
    const read = r.url === '/apis/authentication.k8s.io/v1/selfsubjectreviews' || r.url === '/api/v1/namespaces';
    if (read && o.forbid) return json(403, { kind: 'Status', status: 'Failure', reason: 'Forbidden', message: 'namespaces is forbidden: User "anonymous" cannot list resource "namespaces"' });
    if (r.url === '/apis/authentication.k8s.io/v1/selfsubjectreviews') return json(201, { kind: 'SelfSubjectReview', status: { userInfo: KUBE_USER } });
    if (r.url === '/api/v1/namespaces') return json(200, { kind: 'NamespaceList', items: KUBE_NAMESPACES.map((name) => ({ metadata: { name } })) });
    const spec = (JSON.parse(r.body || '{}') as { spec?: unknown }).spec;
    return { status: 201, type: 'application/json', body: JSON.stringify({ kind: 'TokenRequest', apiVersion: 'authentication.k8s.io/v1', spec, status: { token: MINTED_KUBE_TOKEN, expirationTimestamp: EXPIRES } }) };
  });
};

/**
 * STS: AssumeRole answered, in the query protocol's XML. With `iamAllows` (issue #2206, part 2), it is IAM too: a
 * SimulatePrincipalPolicy answers `allowed` for each action named there, else `implicitDeny`. A GetRole (issue #2387)
 * answers the role, or NoSuchEntity for a role named in `iamMissingRoles`.
 */
export const fakeSts = (account: string, o: { iamAllows?: string[]; iamMissingRoles?: string[] } = {}): Promise<FakeApi> => fakeServer((r) => {
  if (r.body.includes('Action=GetRole')) return gotRole(account, r.body, o.iamMissingRoles ?? []);
  if (o.iamAllows && r.body.includes('Action=SimulatePrincipalPolicy')) return simulated(r.body, o.iamAllows);
  return {
    status: 200, type: 'text/xml',
    body: `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>${MINTED_AWS.AccessKeyId}</AccessKeyId><SecretAccessKey>${MINTED_AWS.SecretAccessKey}</SecretAccessKey><SessionToken>${MINTED_AWS.SessionToken}</SessionToken><Expiration>${EXPIRES}</Expiration></Credentials><AssumedRoleUser><Arn>arn:aws:sts::${account}:assumed-role/readonly/hopper</Arn><AssumedRoleId>AROA:hopper</AssumedRoleId></AssumedRoleUser></AssumeRoleResult><ResponseMetadata><RequestId>r1</RequestId></ResponseMetadata></AssumeRoleResponse>`,
  };
});

/** IAM's GetRole answer: the role, or NoSuchEntity when it is missing. */
function gotRole(account: string, body: string, missing: readonly string[]): { status: number; type: string; body: string } {
  const name = new URLSearchParams(body).get('RoleName') ?? '';
  if (missing.includes(name)) {
    return {
      status: 404, type: 'text/xml',
      body: `<ErrorResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><Error><Type>Sender</Type><Code>NoSuchEntity</Code><Message>The role with name ${name} cannot be found.</Message></Error><RequestId>r3</RequestId></ErrorResponse>`,
    };
  }
  return {
    status: 200, type: 'text/xml',
    body: `<GetRoleResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetRoleResult><Role><Path>/</Path><RoleName>${name}</RoleName><RoleId>AROA${name.length}</RoleId><Arn>arn:aws:iam::${account}:role/${name}</Arn><CreateDate>2026-10-01T00:00:00Z</CreateDate></Role></GetRoleResult><ResponseMetadata><RequestId>r3</RequestId></ResponseMetadata></GetRoleResponse>`,
  };
}

/** IAM's SimulatePrincipalPolicy answer for the one action the request names. */
function simulated(body: string, allows: readonly string[]): { status: number; type: string; body: string } {
  const q = new URLSearchParams(body), action = q.get('ActionNames.member.1') ?? '', resource = q.get('ResourceArns.member.1') ?? '*';
  const decision = allows.includes(action) ? 'allowed' : 'implicitDeny';
  return {
    status: 200, type: 'text/xml',
    body: `<SimulatePrincipalPolicyResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><SimulatePrincipalPolicyResult><IsTruncated>false</IsTruncated><EvaluationResults><member><EvalActionName>${action}</EvalActionName><EvalResourceName>${resource}</EvalResourceName><EvalDecision>${decision}</EvalDecision></member></EvaluationResults></SimulatePrincipalPolicyResult><ResponseMetadata><RequestId>r2</RequestId></ResponseMetadata></SimulatePrincipalPolicyResponse>`,
  };
}
