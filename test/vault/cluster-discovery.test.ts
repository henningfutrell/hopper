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

const UTILITY = '111111111111';
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
    const own = secret('eks-utility', { kind: 'cluster', name: 'utility' });
    expect(mintSourceFor([aws('MINTER_UTILITY', UTILITY), own], clusterTarget('utility'), 'read')).toEqual({ credential: own });
  });

  it('is a discovery in every account an AWS minting credential mints for, as hopper-read, when the cluster has none', () => {
    expect(mintSourceFor([aws('MINTER_UTILITY', UTILITY), aws('MINTER_PROD', PROD), secret('note')], clusterTarget('utility'), 'read')).toEqual({
      discover: { cluster: 'utility', role: 'hopper-read', credentials: [{ name: 'MINTER_UTILITY', account: UTILITY }, { name: 'MINTER_PROD', account: PROD }] },
    });
    // A namespace and an Argo CD app of a cluster are found the same way.
    expect(mintSourceFor([aws('MINTER_UTILITY', UTILITY)], target({ kind: 'namespace', name: 'utility/web' }), 'read')).toMatchObject({ discover: { cluster: 'utility' } });
  });

  it('finds no cluster for a write, with no AWS minting credential, or for a name EKS does not take', () => {
    expect(mintSourceFor([aws('MINTER_UTILITY', UTILITY)], clusterTarget('utility'), 'write')).toMatch(/no minting credential mints for cluster utility.*for a read only, and write needs the role its write is granted to/);
    expect(mintSourceFor([secret('note')], clusterTarget('utility'), 'read')).toMatch(/^no minting credential mints for cluster utility.*or one for an aws-account that has the cluster/);
    expect(mintSourceFor([aws('MINTER_UTILITY', UTILITY)], clusterTarget('utility.lab'), 'read')).toMatch(/utility\.lab is no EKS cluster name/);
  });

  it('picks none of several: several for the cluster, or several for one of the accounts', () => {
    const two = [secret('a', { kind: 'cluster', name: 'utility' }), secret('b', { kind: 'cluster', name: 'utility' }), aws('MINTER_UTILITY', UTILITY)];
    expect(mintSourceFor(two, clusterTarget('utility'), 'read')).toMatch(/2 minting credentials mint for cluster utility: a, b/);
    expect(mintSourceFor([aws('MINTER_UTILITY', UTILITY), aws('OLD_UTILITY', UTILITY)], clusterTarget('utility'), 'read')).toMatch(/cannot find cluster utility: 2 minting credentials mint for aws-account 111111111111: MINTER_UTILITY, OLD_UTILITY/);
  });

  it('is the account\'s minting credential for an aws-role, as before', () => {
    const t = mintTarget('aws', { operation: 'read', asset: { kind: 'aws-role', name: `${UTILITY}/diag` } }) as MintTarget;
    expect(mintSourceFor([aws('MINTER_UTILITY', UTILITY)], t, 'read')).toEqual({ credential: aws('MINTER_UTILITY', UTILITY) });
  });

  // Issue #2168: a short name the topology lists one cluster for is found by that cluster's EKS name; one it lists
  // several for is refused with them, never guessed; a cluster override names it as it says.
  it('finds a short cluster name by the one cluster the topology lists for it, and refuses one with several', () => {
    const minters = [aws('MINTER_UTILITY', UTILITY)];
    expect(mintSourceFor(minters, clusterTarget('utility'), 'read', [], ['prod-eks', 'utility-eks'])).toMatchObject({ discover: { cluster: 'utility-eks' } });
    expect(mintSourceFor(minters, target({ kind: 'namespace', name: 'utility/web' }), 'read', [], ['utility-eks'])).toMatchObject({ discover: { cluster: 'utility-eks' } });
    expect(mintSourceFor(minters, clusterTarget('utility'), 'read', [], ['utility-eks', 'utility-gke'])).toMatch(/cluster utility is ambiguous: utility-eks, utility-gke/);
    expect(mintSourceFor(minters, clusterTarget('utility'), 'read', [{ name: 'utility', eksName: 'utility-gke' }], ['utility-eks'])).toMatchObject({ discover: { cluster: 'utility-gke' } });
    expect(mintSourceFor(minters, clusterTarget('utility'), 'read', [], ['utility', 'utility-eks'])).toMatchObject({ discover: { cluster: 'utility' } });
  });
});

interface Fake { minter: CredentialMinter; assumed: string[]; described: string[] }

/** A minter that assumes any role but those of the accounts `refuse` and the roles `refuseRoles`, and has the cluster `utility` in the accounts `has`. */
function fakeMinter(has: string[], refuse: string[] = [], refuseRoles: string[] = []): Fake {
  const fake: Fake = { assumed: [], described: [], minter: undefined as unknown as CredentialMinter };
  fake.minter = {
    async awsSession(_c, r) {
      fake.assumed.push(r.roleArn);
      if (refuse.some((a) => r.roleArn.includes(`::${a}:`)) || refuseRoles.some((n) => r.roleArn.endsWith(`:role/${n}`))) throw new Error(`STS refused AssumeRole on ${r.roleArn}: AccessDenied`);
      return { kind: 'aws', AccessKeyId: `ASIA-${r.roleArn}`, SecretAccessKey: 's', SessionToken: 't', Expiration: '2030-01-01T00:15:00Z' };
    },
    async awsRegions(_session, r) { return [r.region]; },
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
const secrets = [aws('MINTER_UTILITY', UTILITY), aws('MINTER_PROD', PROD)];
const values: Record<string, string> = { MINTER_UTILITY: keys('eu-west-1'), MINTER_PROD: keys('us-east-2') };
const fromHere = (f: Fake, v = values) => mintHere({
  vault: { get: (n) => secrets.find((s) => s.name === n), list: () => secrets }, minter: f.minter, valueOf: async (s) => ({ value: v[s.name]! }),
});
const discovery = { cluster: 'utility', role: 'hopper-read', credentials: [{ name: 'MINTER_UTILITY', account: UTILITY }, { name: 'MINTER_PROD', account: PROD }] };

describe('a mint for a discovered cluster', () => {
  it('signs the token with the hopper-read session of the one account that has the cluster, in its credential\'s region', async () => {
    const f = fakeMinter([PROD]);
    const made = await fromHere(f)(discovery, clusterTarget('utility'), 'job-1');
    expect(f.assumed).toEqual([`arn:aws:iam::${UTILITY}:role/hopper-read`, `arn:aws:iam::${PROD}:role/hopper-read`]);
    expect(f.described).toEqual([`${UTILITY} eu-west-1 utility`, `${PROD} us-east-2 utility`]);
    expect(made).toMatchObject({
      minted: { kind: 'kube', token: `eks:ASIA-arn:aws:iam::${PROD}:role/hopper-read:utility` }, reach: { kind: 'kube', server: SERVER, certificateAuthorityData: 'Q0E=' },
      roleArn: `arn:aws:iam::${PROD}:role/hopper-read`, sessionName: 'hopper-job-1', credential: 'MINTER_PROD', account: PROD,
    });
  });

  it('passes over an account STS refuses, and finds the cluster in another', async () => {
    expect(await fromHere(fakeMinter([PROD], [UTILITY]))(discovery, clusterTarget('utility'), 'job-1')).toMatchObject({ credential: 'MINTER_PROD', account: PROD });
  });

  it('asks no EKS of AWS\'s for a credential whose STS is not AWS\'s, and asks the EKS it names', async () => {
    const f = fakeMinter([PROD]);
    const own = (eks?: string) => JSON.stringify({ AccessKeyId: 'AKIA', SecretAccessKey: 'x', Region: 'us-east-2', Endpoint: 'https://sts.lab', ...(eks ? { EksEndpoint: eks } : {}) });
    const made = await fromHere(f, { MINTER_UTILITY: own(), MINTER_PROD: own('https://eks.lab') })(discovery, clusterTarget('utility'), 'job-1');
    expect(f.assumed).toEqual([`arn:aws:iam::${PROD}:role/hopper-read`]);
    expect(f.described).toEqual([`${PROD} us-east-2 utility at https://eks.lab`]);
    expect(made).toMatchObject({ credential: 'MINTER_PROD' });
    const none = await fromHere(fakeMinter([UTILITY]), { MINTER_UTILITY: own(), MINTER_PROD: own() })(discovery, clusterTarget('utility'), 'job-1');
    expect(none).toEqual({ refused: expect.stringContaining('111111111111: MINTER_UTILITY names an STS endpoint and no EksEndpoint') });
  });

  it('mints nothing when no account has the cluster, and says where it looked', async () => {
    const made = await fromHere(fakeMinter([], [PROD]))(discovery, clusterTarget('utility'), 'job-1');
    expect(made).toEqual({ refused: expect.stringMatching(/found it in none of the accounts it mints for \(111111111111 in eu-west-1: none; 222222222222 in us-east-2: STS refused AssumeRole/) });
  });

  it('says what to change when STS refuses the observe role of the account that has the cluster (issue #2340)', async () => {
    const f = fakeMinter([PROD], [], ['hopper-observe']);
    const observe = { ...discovery, role: 'hopper-observe' };
    expect(await fromHere(f)(observe, clusterTarget('utility'), 'job-1')).toEqual({ refused: expect.stringMatching(new RegExp([
      `STS refused AssumeRole on arn:aws:iam::${PROD}:role/hopper-observe: AccessDenied\\.`,
      `The identity of the minting credential MINTER_PROD needs sts:AssumeRole on arn:aws:iam::${PROD}:role/hopper-observe in its own policy,`,
      'and that role\'s trust policy must let it assume the role \\(docs/deploy\\.md "The observe role"\\)',
    ].join(' '))) });
    expect(f.assumed).toContain(`arn:aws:iam::${PROD}:role/hopper-observe`);
  });

  it('picks no account of several that have the cluster', async () => {
    const made = await fromHere(fakeMinter([UTILITY, PROD]))(discovery, clusterTarget('utility'), 'job-1');
    expect(made).toEqual({ refused: expect.stringMatching(/EKS has a cluster utility in 2 places: 111111111111 in eu-west-1 \(MINTER_UTILITY\), 222222222222 in us-east-2 \(MINTER_PROD\)/) });
  });
});

describe('a mint test of a discovered cluster', () => {
  it('names the account, the role and the minting credential it used', async () => {
    const events: { type: string; data: unknown }[] = [];
    const test = createMintTest({ store: { vault: { list: () => secrets } as never, config: { read: () => undefined } as never, topology: { list: () => [] } as never, events: { append: (e: { type: string; data: unknown }) => { events.push(e); } } as never } });
    const r = await test('cluster/utility', 'admin', fromHere(fakeMinter([UTILITY])));
    expect(r).toEqual({
      tested: {
        kind: 'kube', asset: { kind: 'cluster', name: 'utility' }, credential: 'MINTER_UTILITY', server: SERVER, expiresAt: '2030-01-01T00:14:00.000Z',
        roleArn: `arn:aws:iam::${UTILITY}:role/hopper-read`, account: UTILITY, sessionName: 'hopper-mint-test',
        region: 'eu-west-1', searched: [{ account: UTILITY, regions: ['eu-west-1'] }, { account: PROD, regions: ['us-east-2'] }],
        user: { username: `as eks:ASIA-arn:aws:iam::${UTILITY}:role/hopper-read:utility`, groups: ['hopper:view'] }, namespaces: ['web'],
      },
    });
    expect(events).toEqual([{ type: 'vault.mint_tested', data: expect.objectContaining({ credential: 'MINTER_UTILITY', roleArn: `arn:aws:iam::${UTILITY}:role/hopper-read`, account: UTILITY }) }]);
    expect(JSON.stringify([r, events])).not.toContain('never-shown');
  });
});

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.close(r); s.closeAllConnections(); }))); });

/** EKS on loopback: DescribeCluster answers `utility`, and ResourceNotFoundException for any other name. */
async function eksApi(): Promise<{ url: string; seen: { path: string; authorization: string }[] }> {
  const seen: { path: string; authorization: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', authorization: req.headers.authorization ?? '' });
    const send = (status: number, body: unknown, type?: string) => res.writeHead(status, { 'content-type': 'application/json', ...(type ? { 'x-amzn-errortype': type } : {}) }).end(JSON.stringify(body));
    if (req.url === '/clusters/utility') return send(200, { cluster: { name: 'utility', endpoint: SERVER, certificateAuthority: { data: 'Q0E=' } } });
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
    expect(await createCredentialMinter().eksCluster(session, { cluster: 'utility', region: 'eu-west-1', endpoint: eks.url })).toEqual({ cluster: 'utility', region: 'eu-west-1', server: SERVER, certificateAuthorityData: 'Q0E=' });
    expect(eks.seen[0]!.authorization).toContain('Credential=ASIAMINTED/');
    expect(eks.seen[0]!.authorization).toContain('/eu-west-1/eks/aws4_request');
  });

  it('answers no cluster when the account has none of that name', async () => {
    const eks = await eksApi();
    expect(await createCredentialMinter().eksCluster(session, { cluster: 'other', region: 'eu-west-1', endpoint: eks.url })).toBeUndefined();
  });
});
