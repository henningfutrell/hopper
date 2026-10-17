// Issue #1766: a cluster with no minting credential of its own is found in the AWS accounts the vault mints for. In each
// account the vault mints a read session of `hopper-read` and asks EKS for the cluster (DescribeCluster); the one account
// that has it signs the EKS token with that session. The pure source choice (`mintSourceFor`), the discovery mint and the
// mint test with a fake minter, and the real EKS adapter against an EKS double on loopback.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { mintSourceFor } from '../../src/domain/cluster-discovery.ts';
import { mintTarget, type CredentialMinter, type EksCluster, type MintTarget } from '../../src/domain/minting.ts';
import type { Asset } from '../../src/domain/access.ts';
import type { VaultSecret } from '../../src/domain/vault.ts';
import { mintHere } from '../../src/vault/mint.ts';
import { createMintTest } from '../../src/vault/mint-test.ts';
import { createCredentialMinter } from '../../src/vault/minter.ts';

const UAT = '111111111111';
const PROD = '222222222222';
const SERVER = 'https://ABC.gr7.eu-west-1.eks.amazonaws.com';

const secret = (name: string, mints?: Asset): VaultSecret => ({
  id: `id-${name}`, name, setBy: 'admin', createdAt: '2030-01-01T00:00:00Z', changedBy: 'admin', changedAt: '2030-01-01T00:00:00Z', ...(mints ? { mints } : {}),
});
const aws = (name: string, account: string): VaultSecret => secret(name, { kind: 'aws-account', name: account });
const target = (asset: Asset): MintTarget => mintTarget('kube', { operation: 'read', asset }) as MintTarget;
const clusterTarget = (name: string): MintTarget => target({ kind: 'cluster', name });

describe('where the vault mints a cluster from', () => {
  it('is the cluster\'s own minting credential when there is one', () => {
    const own = secret('eks-uat', { kind: 'cluster', name: 'uat' });
    expect(mintSourceFor([aws('MINTER_UAT', UAT), own], clusterTarget('uat'), 'read')).toEqual({ credential: own });
  });

  it('is a discovery in every account an AWS minting credential mints for, as hopper-read, when the cluster has none', () => {
    expect(mintSourceFor([aws('MINTER_UAT', UAT), aws('MINTER_PROD', PROD), secret('note')], clusterTarget('uat'), 'read')).toEqual({
      discover: { cluster: 'uat', role: 'hopper-read', credentials: [{ name: 'MINTER_UAT', account: UAT }, { name: 'MINTER_PROD', account: PROD }] },
    });
    // A namespace and an Argo CD app of a cluster are found the same way.
    expect(mintSourceFor([aws('MINTER_UAT', UAT)], target({ kind: 'namespace', name: 'uat/web' }), 'read')).toMatchObject({ discover: { cluster: 'uat' } });
  });

  it('finds no cluster for a write, with no AWS minting credential, or for a name EKS does not take', () => {
    expect(mintSourceFor([aws('MINTER_UAT', UAT)], clusterTarget('uat'), 'write')).toMatch(/no minting credential mints for cluster uat.*for a read only, and write needs the role its write is granted to/);
    expect(mintSourceFor([secret('note')], clusterTarget('uat'), 'read')).toMatch(/^no minting credential mints for cluster uat.*or one for an aws-account that has the cluster/);
    expect(mintSourceFor([aws('MINTER_UAT', UAT)], clusterTarget('uat.lab'), 'read')).toMatch(/uat\.lab is no EKS cluster name/);
  });

  it('picks none of several: several for the cluster, or several for one of the accounts', () => {
    const two = [secret('a', { kind: 'cluster', name: 'uat' }), secret('b', { kind: 'cluster', name: 'uat' }), aws('MINTER_UAT', UAT)];
    expect(mintSourceFor(two, clusterTarget('uat'), 'read')).toMatch(/2 minting credentials mint for cluster uat: a, b/);
    expect(mintSourceFor([aws('MINTER_UAT', UAT), aws('OLD_UAT', UAT)], clusterTarget('uat'), 'read')).toMatch(/cannot find cluster uat: 2 minting credentials mint for aws-account 111111111111: MINTER_UAT, OLD_UAT/);
  });

  it('is the account\'s minting credential for an aws-role, as before', () => {
    const t = mintTarget('aws', { operation: 'read', asset: { kind: 'aws-role', name: `${UAT}/diag` } }) as MintTarget;
    expect(mintSourceFor([aws('MINTER_UAT', UAT)], t, 'read')).toEqual({ credential: aws('MINTER_UAT', UAT) });
  });
});

interface Fake { minter: CredentialMinter; assumed: string[]; described: string[] }

/** A minter that assumes any role but `refuse`, and has the cluster `uat` in the accounts `has`. */
function fakeMinter(has: string[], refuse: string[] = []): Fake {
  const fake: Fake = { assumed: [], described: [], minter: undefined as unknown as CredentialMinter };
  fake.minter = {
    async awsSession(_c, r) {
      fake.assumed.push(r.roleArn);
      if (refuse.some((a) => r.roleArn.includes(`::${a}:`))) throw new Error(`STS refused AssumeRole on ${r.roleArn}: AccessDenied`);
      return { kind: 'aws', AccessKeyId: `ASIA-${r.roleArn}`, SecretAccessKey: 's', SessionToken: 't', Expiration: '2030-01-01T00:15:00Z' };
    },
    async eksCluster(session, r): Promise<EksCluster | undefined> {
      const account = /::(\d{12}):/.exec(session.AccessKeyId)![1]!;
      fake.described.push(`${account} ${r.region} ${r.cluster}${r.endpoint ? ` at ${r.endpoint}` : ''}`);
      return has.includes(account) ? { cluster: r.cluster, region: r.region, server: SERVER, certificateAuthorityData: 'Q0E=' } : undefined;
    },
    async eksToken(session, r) { return { kind: 'kube', token: `eks:${session.AccessKeyId}:${r.cluster}`, expirationTimestamp: '2030-01-01T00:14:00Z' }; },
    async kubeIdentity(_reach, token) { return { user: { username: `as ${token}`, groups: ['hopper:view'] }, namespaces: ['web'] }; },
    async kubeToken() { throw new Error('no TokenRequest for a discovered cluster'); },
    async kubeUnbind() { throw new Error('no unbind'); },
    async awsCallerIdentity() { throw new Error('not asked'); },
  };
  return fake;
}

const keys = (region: string) => JSON.stringify({ AccessKeyId: 'AKIA', SecretAccessKey: 'never-shown', Region: region });
const secrets = [aws('MINTER_UAT', UAT), aws('MINTER_PROD', PROD)];
const values: Record<string, string> = { MINTER_UAT: keys('eu-west-1'), MINTER_PROD: keys('us-east-2') };
const fromHere = (f: Fake, v = values) => mintHere({
  vault: { get: (n) => secrets.find((s) => s.name === n), list: () => secrets }, minter: f.minter, valueOf: async (s) => ({ value: v[s.name]! }),
});
const discovery = { cluster: 'uat', role: 'hopper-read', credentials: [{ name: 'MINTER_UAT', account: UAT }, { name: 'MINTER_PROD', account: PROD }] };

describe('a mint for a discovered cluster', () => {
  it('signs the token with the hopper-read session of the one account that has the cluster, in its credential\'s region', async () => {
    const f = fakeMinter([PROD]);
    const made = await fromHere(f)(discovery, clusterTarget('uat'), 'job-1');
    expect(f.assumed).toEqual([`arn:aws:iam::${UAT}:role/hopper-read`, `arn:aws:iam::${PROD}:role/hopper-read`]);
    expect(f.described).toEqual([`${UAT} eu-west-1 uat`, `${PROD} us-east-2 uat`]);
    expect(made).toMatchObject({
      minted: { kind: 'kube', token: `eks:ASIA-arn:aws:iam::${PROD}:role/hopper-read:uat` }, reach: { kind: 'kube', server: SERVER, certificateAuthorityData: 'Q0E=' },
      roleArn: `arn:aws:iam::${PROD}:role/hopper-read`, sessionName: 'hopper-job-1', credential: 'MINTER_PROD', account: PROD,
    });
  });

  it('passes over an account STS refuses, and finds the cluster in another', async () => {
    expect(await fromHere(fakeMinter([PROD], [UAT]))(discovery, clusterTarget('uat'), 'job-1')).toMatchObject({ credential: 'MINTER_PROD', account: PROD });
  });

  it('asks no EKS of AWS\'s for a credential whose STS is not AWS\'s, and asks the EKS it names', async () => {
    const f = fakeMinter([PROD]);
    const own = (eks?: string) => JSON.stringify({ AccessKeyId: 'AKIA', SecretAccessKey: 'x', Region: 'us-east-2', Endpoint: 'https://sts.lab', ...(eks ? { EksEndpoint: eks } : {}) });
    const made = await fromHere(f, { MINTER_UAT: own(), MINTER_PROD: own('https://eks.lab') })(discovery, clusterTarget('uat'), 'job-1');
    expect(f.assumed).toEqual([`arn:aws:iam::${PROD}:role/hopper-read`]);
    expect(f.described).toEqual([`${PROD} us-east-2 uat at https://eks.lab`]);
    expect(made).toMatchObject({ credential: 'MINTER_PROD' });
    const none = await fromHere(fakeMinter([UAT]), { MINTER_UAT: own(), MINTER_PROD: own() })(discovery, clusterTarget('uat'), 'job-1');
    expect(none).toEqual({ refused: expect.stringContaining('111111111111: MINTER_UAT names an STS endpoint and no EksEndpoint') });
  });

  it('mints nothing when no account has the cluster, and says where it looked', async () => {
    const made = await fromHere(fakeMinter([], [PROD]))(discovery, clusterTarget('uat'), 'job-1');
    expect(made).toEqual({ refused: expect.stringMatching(/found it in none of the accounts it mints for \(111111111111 in eu-west-1: none; 222222222222 in us-east-2: STS refused AssumeRole/) });
  });

  it('picks no account of several that have the cluster', async () => {
    const made = await fromHere(fakeMinter([UAT, PROD]))(discovery, clusterTarget('uat'), 'job-1');
    expect(made).toEqual({ refused: expect.stringMatching(/EKS has a cluster uat in 2 accounts: 111111111111 \(MINTER_UAT\), 222222222222 \(MINTER_PROD\)/) });
  });
});

describe('a mint test of a discovered cluster', () => {
  it('names the account, the role and the minting credential it used', async () => {
    const events: { type: string; data: unknown }[] = [];
    const test = createMintTest({ store: { vault: { list: () => secrets } as never, config: { read: () => undefined } as never, events: { append: (e: { type: string; data: unknown }) => { events.push(e); } } as never } });
    const r = await test('cluster/uat', 'admin', fromHere(fakeMinter([UAT])));
    expect(r).toEqual({
      tested: {
        kind: 'kube', asset: { kind: 'cluster', name: 'uat' }, credential: 'MINTER_UAT', server: SERVER, expiresAt: '2030-01-01T00:14:00.000Z',
        roleArn: `arn:aws:iam::${UAT}:role/hopper-read`, account: UAT, sessionName: 'hopper-mint-test',
        user: { username: `as eks:ASIA-arn:aws:iam::${UAT}:role/hopper-read:uat`, groups: ['hopper:view'] }, namespaces: ['web'],
      },
    });
    expect(events).toEqual([{ type: 'vault.mint_tested', data: expect.objectContaining({ credential: 'MINTER_UAT', roleArn: `arn:aws:iam::${UAT}:role/hopper-read`, account: UAT }) }]);
    expect(JSON.stringify([r, events])).not.toContain('never-shown');
  });
});

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.close(r); s.closeAllConnections(); }))); });

/** EKS on loopback: DescribeCluster answers `uat`, and ResourceNotFoundException for any other name. */
async function eksApi(): Promise<{ url: string; seen: { path: string; authorization: string }[] }> {
  const seen: { path: string; authorization: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', authorization: req.headers.authorization ?? '' });
    const send = (status: number, body: unknown, type?: string) => res.writeHead(status, { 'content-type': 'application/json', ...(type ? { 'x-amzn-errortype': type } : {}) }).end(JSON.stringify(body));
    if (req.url === '/clusters/uat') return send(200, { cluster: { name: 'uat', endpoint: SERVER, certificateAuthority: { data: 'Q0E=' } } });
    return send(404, { message: 'No cluster found for name: other.' }, 'ResourceNotFoundException');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe('the EKS adapter', () => {
  const session = { kind: 'aws' as const, AccessKeyId: 'ASIAMINTED', SecretAccessKey: 's', SessionToken: 't', Expiration: '2030-01-01T00:15:00Z' };

  it('describes a cluster with the session: its API server and CA', async () => {
    const eks = await eksApi();
    expect(await createCredentialMinter().eksCluster(session, { cluster: 'uat', region: 'eu-west-1', endpoint: eks.url })).toEqual({ cluster: 'uat', region: 'eu-west-1', server: SERVER, certificateAuthorityData: 'Q0E=' });
    expect(eks.seen[0]!.authorization).toContain('Credential=ASIAMINTED/');
    expect(eks.seen[0]!.authorization).toContain('/eu-west-1/eks/aws4_request');
  });

  it('answers no cluster when the account has none of that name', async () => {
    const eks = await eksApi();
    expect(await createCredentialMinter().eksCluster(session, { cluster: 'other', region: 'eu-west-1', endpoint: eks.url })).toBeUndefined();
  });
});
