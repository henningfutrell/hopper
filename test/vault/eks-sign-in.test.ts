// Issue #854: a cluster minting credential that signs in through EKS. Its value names the AWS role to assume and the
// cluster (its name, region, API server and CA), or a vault kubeconfig whose EKS exec sign-in names them. The token is
// `k8s-aws-v1.` and an STS GetCallerIdentity URL presigned with the role's read session, the cluster's name signed in the
// `x-k8s-aws-id` header. Pure parts (`mintingCredentialOf`, `eksClusterOf`) and the real signer (`eksToken`): no network.
import { describe, expect, it } from 'vitest';
import { mintingCredentialOf, type EksMintingCredential } from '../../src/domain/minting.ts';
import { eksClusterOf } from '../../src/vault/eks.ts';
import { createCredentialMinter } from '../../src/vault/minter.ts';

const ROLE = 'arn:aws:iam::123456789012:role/eks-view';
const CA = Buffer.from('-----BEGIN CERTIFICATE-----\nlab\n-----END CERTIFICATE-----\n').toString('base64');
const SERVER = 'https://ABCDEF0123456789.gr7.eu-west-1.eks.amazonaws.com';

const eks = (v: Record<string, unknown>) => mintingCredentialOf('kube', JSON.stringify({ type: 'eks', roleArn: ROLE, ...v }));

/** The presigned URL inside an EKS token. */
const urlOf = (token: string): URL => {
  expect(token.startsWith('k8s-aws-v1.')).toBe(true);
  const b64 = token.slice('k8s-aws-v1.'.length);
  expect(b64).not.toMatch(/[=+/]/);
  return new URL(Buffer.from(b64, 'base64url').toString('utf8'));
};

describe('a kube minting credential that signs in through EKS', () => {
  it('reads a token credential as before, with no type', () => {
    expect(mintingCredentialOf('kube', JSON.stringify({ server: 'https://lab:6443', token: 't' }))).toEqual({ type: 'token', server: 'https://lab:6443', token: 't' });
  });

  it('reads an eks credential with the cluster named in it', () => {
    expect(eks({ cluster: 'utility', region: 'eu-west-1', server: SERVER, certificateAuthorityData: CA })).toEqual({
      type: 'eks', roleArn: ROLE, cluster: 'utility', region: 'eu-west-1', server: SERVER, certificateAuthorityData: CA,
    });
  });

  it('reads an eks credential that takes the cluster from a vault kubeconfig', () => {
    expect(eks({ kubeconfig: 'kube-config', context: 'utility' })).toEqual({ type: 'eks', roleArn: ROLE, kubeconfig: 'kube-config', context: 'utility' });
  });

  it('refuses an eks credential with no role, a role that is no IAM role, or no cluster and no kubeconfig', () => {
    expect(mintingCredentialOf('kube', JSON.stringify({ type: 'eks', cluster: 'utility', region: 'eu-west-1', server: SERVER }))).toMatch(/roleArn/);
    expect(eks({ roleArn: 'arn:aws:iam::123456789012:user/me', kubeconfig: 'k' })).toMatch(/roleArn/);
    expect(eks({ cluster: 'utility' })).toMatch(/cluster, region and server, or kubeconfig/);
    expect(eks({ cluster: 'utility', region: 'eu-west-1', server: 'ftp://x' })).toMatch(/cluster, region and server, or kubeconfig/);
    expect(mintingCredentialOf('kube', JSON.stringify({ type: 'oidc' }))).toMatch(/type is token or eks/);
  });
});

const KUBECONFIG = `apiVersion: v1
kind: Config
current-context: arn:aws:eks:eu-west-1:123456789012:cluster/utility
clusters:
- name: arn:aws:eks:eu-west-1:123456789012:cluster/utility
  cluster:
    server: ${SERVER}
    certificate-authority-data: ${CA}
- name: lab
  cluster: { server: 'https://lab.example:6443' }
contexts:
- name: arn:aws:eks:eu-west-1:123456789012:cluster/utility
  context: { cluster: 'arn:aws:eks:eu-west-1:123456789012:cluster/utility', user: 'arn:aws:eks:eu-west-1:123456789012:cluster/utility' }
- name: lab
  context: { cluster: lab, user: lab }
users:
- name: arn:aws:eks:eu-west-1:123456789012:cluster/utility
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
      args: [--region, eu-west-1, eks, get-token, --cluster-name, utility, --output, json]
      env: [{ name: AWS_PROFILE, value: ledger }]
- name: lab
  user: { token: abc }
`;

describe('the cluster an eks credential signs in to', () => {
  const fromKubeconfig = (v: Record<string, unknown>, kubeconfig = KUBECONFIG) => eksClusterOf(eks({ kubeconfig: 'kube-config', ...v }) as EksMintingCredential, kubeconfig);

  it('is the one the credential names', () => {
    expect(eksClusterOf(eks({ cluster: 'utility', region: 'eu-west-1', server: SERVER }) as EksMintingCredential, undefined)).toEqual({ cluster: 'utility', region: 'eu-west-1', server: SERVER });
  });

  it('is found in the kubeconfig\'s current context: the server, its CA, and the cluster and region of its EKS sign-in', () => {
    expect(fromKubeconfig({})).toEqual({ cluster: 'utility', region: 'eu-west-1', server: SERVER, certificateAuthorityData: CA });
  });

  it('takes --cluster-name=, the region from the environment or the server, and lets the credential\'s own fields win', () => {
    const other = KUBECONFIG.replace('[--region, eu-west-1, eks, get-token, --cluster-name, utility, --output, json]', '[eks, get-token, --cluster-name=utility]')
      .replace('{ name: AWS_PROFILE, value: ledger }', '{ name: AWS_REGION, value: eu-central-1 }');
    expect(fromKubeconfig({}, other)).toMatchObject({ cluster: 'utility', region: 'eu-central-1' });
    expect(fromKubeconfig({}, other.replace('{ name: AWS_REGION, value: eu-central-1 }', '{ name: X, value: y }'))).toMatchObject({ region: 'eu-west-1' });
    expect(fromKubeconfig({ cluster: 'utility-blue', region: 'us-east-2' })).toMatchObject({ cluster: 'utility-blue', region: 'us-east-2', server: SERVER });
  });

  it('says why when the kubeconfig gives no EKS sign-in, has no such context, or is not one', () => {
    expect(fromKubeconfig({ context: 'lab' })).toMatch(/context lab signs in with no EKS exec .*cluster/);
    expect(fromKubeconfig({ context: 'gone' })).toMatch(/no context gone/);
    expect(fromKubeconfig({}, ': not yaml : [')).toMatch(/not a kubeconfig/);
    expect(eksClusterOf(eks({ kubeconfig: 'kube-config' }) as EksMintingCredential, undefined)).toMatch(/kube-config/);
  });
});

describe('an EKS token', () => {
  const session = { kind: 'aws' as const, AccessKeyId: 'ASIAMINTED', SecretAccessKey: 'minted-secret', SessionToken: 'minted+session/token=', Expiration: '2099-01-01T00:15:00Z' };

  it('is a GetCallerIdentity URL presigned with the session, at the cluster region\'s STS, the cluster named in a signed header', async () => {
    const before = Date.now();
    const minted = await createCredentialMinter().eksToken(session, { cluster: 'utility', region: 'eu-west-1' });
    const url = urlOf(minted.token);
    expect(url.origin).toBe('https://sts.eu-west-1.amazonaws.com');
    expect(url.pathname).toBe('/');
    const q = url.searchParams;
    expect(q.get('Action')).toBe('GetCallerIdentity');
    expect(q.get('Version')).toBe('2011-06-15');
    expect(q.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(q.get('X-Amz-Credential')).toMatch(/^ASIAMINTED\/\d{8}\/eu-west-1\/sts\/aws4_request$/);
    expect(q.get('X-Amz-Expires')).toBe('60');
    expect(q.get('X-Amz-SignedHeaders')).toBe('host;x-k8s-aws-id');
    expect(q.get('X-Amz-Security-Token')).toBe('minted+session/token=');
    expect(q.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    // A token lives 14 minutes, as `aws eks get-token` says: EKS takes a presigned URL for 15 minutes from its signing.
    const expires = Date.parse(minted.expirationTimestamp);
    expect(expires - before).toBeGreaterThanOrEqual(14 * 60_000 - 1000);
    expect(expires - Date.now()).toBeLessThanOrEqual(14 * 60_000);
  });

  it('expires no later than the session that signed it', async () => {
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    const minted = await createCredentialMinter().eksToken({ ...session, Expiration: soon }, { cluster: 'utility', region: 'eu-west-1' });
    expect(minted.expirationTimestamp).toBe(soon);
  });

  it('is signed at the China partition\'s STS for a China region', async () => {
    const minted = await createCredentialMinter().eksToken(session, { cluster: 'utility', region: 'cn-north-1' });
    expect(urlOf(minted.token).origin).toBe('https://sts.cn-north-1.amazonaws.com.cn');
  });
});
