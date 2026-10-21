// Issue #1845: a cluster with no minting credential of its own is found in every enabled region of each AWS account the
// vault mints for, not only in the credential's region; the mint test says where it looked and where it found it. An EKS
// minting credential whose kubeconfig secret is gone gives way to discovery, with a warning. A check that failed as the
// vault minted nothing runs again by itself. The discovery mint and the mint test with a fake minter, the real EC2
// adapter against an EC2 double on loopback.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { mintTarget, type CredentialMinter, type EksCluster, type MintTarget } from '../../src/domain/minting.ts';
import type { Asset } from '../../src/domain/access.ts';
import type { Template, VaultSecret } from '../../src/domain/vault.ts';
import { mintHere } from '../../src/vault/mint.ts';
import { createMintTest } from '../../src/vault/mint-test.ts';
import { createCredentialMinter } from '../../src/vault/minter.ts';
import { recheckUnminted } from '../../src/vault/checks.ts';
import { CHECK_UNMINTED_MS, dueForCheck } from '../../src/sandbox/check.ts';
import { checkWait } from '../../src/domain/read-only-check.ts';

const UAT = '111111111111';
const PROD = '222222222222';
const SERVER = 'https://ABC.gr7.us-east-2.eks.amazonaws.com';

const secret = (name: string, mints?: Asset): VaultSecret => ({
  id: `id-${name}`, name, setBy: 'admin', createdAt: '2030-01-01T00:00:00Z', changedBy: 'admin', changedAt: '2030-01-01T00:00:00Z', ...(mints ? { mints } : {}),
});
const aws = (name: string, account: string): VaultSecret => secret(name, { kind: 'aws-account', name: account });
const clusterTarget = (name: string): MintTarget => mintTarget('kube', { operation: 'read', asset: { kind: 'cluster', name } }) as MintTarget;

interface Fake { minter: CredentialMinter; described: string[]; listed: string[] }

/**
 * A minter whose accounts have the regions `regions` (an account not named: its regions cannot be listed), and the
 * cluster `uat-eks` in the regions `has` names, by account.
 */
function fakeMinter(regions: Record<string, string[]>, has: Record<string, string[]>): Fake {
  const fake: Fake = { described: [], listed: [], minter: undefined as unknown as CredentialMinter };
  const accountOf = (key: string) => /::(\d{12}):/.exec(key)![1]!;
  fake.minter = {
    async awsSession(_c, r) { return { kind: 'aws', AccessKeyId: `ASIA-${r.roleArn}`, SecretAccessKey: 's', SessionToken: 't', Expiration: '2030-01-01T00:15:00Z' }; },
    async awsRegions(session, r) {
      const account = accountOf(session.AccessKeyId);
      fake.listed.push(`${account} ${r.region}`);
      const all = regions[account];
      if (!all) throw new Error('EC2 refused DescribeRegions: UnauthorizedOperation');
      return all;
    },
    async eksCluster(session, r): Promise<EksCluster | undefined> {
      const account = accountOf(session.AccessKeyId);
      fake.described.push(`${account} ${r.region} ${r.cluster}`);
      return (has[account] ?? []).includes(r.region) ? { cluster: r.cluster, region: r.region, server: SERVER, certificateAuthorityData: 'Q0E=' } : undefined;
    },
    async eksToken(session, r) { return { kind: 'kube', token: `eks:${session.AccessKeyId}:${r.cluster}`, expirationTimestamp: '2030-01-01T00:14:00Z' }; },
    async kubeIdentity(_reach, token) { return { user: { username: `as ${token}`, groups: ['hopper:view'] }, namespaces: ['web'] }; },
    async kubeToken() { throw new Error('no TokenRequest for a discovered cluster'); },
    async kubeUnbind() { throw new Error('no unbind'); },
    async awsCallerIdentity() { throw new Error('not asked'); },
  };
  return fake;
}

const keys = JSON.stringify({ AccessKeyId: 'AKIA', SecretAccessKey: 'never-shown', Region: 'us-east-1' });
const fromHere = (f: Fake, secrets: VaultSecret[], values: Record<string, string> = {}) => mintHere({
  vault: { get: (n) => secrets.find((s) => s.name === n), list: () => secrets }, minter: f.minter, valueOf: async (s) => ({ value: values[s.name] ?? keys }),
});
const credentials = [{ name: 'MINTER_UAT', account: UAT }, { name: 'MINTER_PROD', account: PROD }];
const discovery = { cluster: 'uat-eks', role: 'hopper-read', credentials };
const two = [aws('MINTER_UAT', UAT), aws('MINTER_PROD', PROD)];

describe('a discovery in every region (issue #1845)', () => {
  it('lists the regions of each account with its hopper-read session, and finds the cluster outside the credential\'s region', async () => {
    const f = fakeMinter({ [UAT]: ['us-east-1', 'us-east-2'], [PROD]: ['us-east-1', 'us-east-2'] }, { [UAT]: ['us-east-2'] });
    const made = await fromHere(f, two)(discovery, clusterTarget('uat-eks'), 'job-1');
    expect(f.listed).toEqual([`${UAT} us-east-1`, `${PROD} us-east-1`]);
    expect(f.described.sort()).toEqual([`${UAT} us-east-1 uat-eks`, `${UAT} us-east-2 uat-eks`, `${PROD} us-east-1 uat-eks`, `${PROD} us-east-2 uat-eks`]);
    expect(made).toMatchObject({
      credential: 'MINTER_UAT', account: UAT, region: 'us-east-2', roleArn: `arn:aws:iam::${UAT}:role/hopper-read`,
      searched: [{ account: UAT, regions: ['us-east-1', 'us-east-2'] }, { account: PROD, regions: ['us-east-1', 'us-east-2'] }],
    });
  });

  it('looks in the credential\'s region only when the account\'s regions cannot be listed, and says so', async () => {
    const f = fakeMinter({}, {});
    const made = await fromHere(f, two)(discovery, clusterTarget('uat-eks'), 'job-1');
    expect(f.described).toEqual([`${UAT} us-east-1 uat-eks`, `${PROD} us-east-1 uat-eks`]);
    expect(made).toEqual({ refused: expect.stringContaining(`${UAT} in us-east-1 (its regions could not be listed: EC2 refused DescribeRegions: UnauthorizedOperation): none`) });
  });

  it('looks in the override\'s region only, and lists no regions', async () => {
    const f = fakeMinter({ [UAT]: ['us-east-1', 'us-east-2'] }, { [UAT]: ['eu-west-1'] });
    const made = await fromHere(f, two)({ ...discovery, region: 'eu-west-1' }, clusterTarget('uat-eks'), 'job-1');
    expect(f.listed).toEqual([]);
    expect(made).toMatchObject({ region: 'eu-west-1', account: UAT });
  });

  it('picks no region of several in one account that have the cluster', async () => {
    const f = fakeMinter({ [UAT]: ['us-east-1', 'us-east-2'], [PROD]: ['us-east-1'] }, { [UAT]: ['us-east-1', 'us-east-2'] });
    const made = await fromHere(f, two)(discovery, clusterTarget('uat-eks'), 'job-1');
    expect(made).toEqual({ refused: expect.stringMatching(/EKS has a cluster uat-eks in 2 places: 111111111111 in us-east-1 \(MINTER_UAT\), 111111111111 in us-east-2 \(MINTER_UAT\)/) });
  });

  it('names every region it looked in when no account has the cluster', async () => {
    const f = fakeMinter({ [UAT]: ['us-east-1', 'us-east-2'], [PROD]: ['us-east-1'] }, {});
    const made = await fromHere(f, two)(discovery, clusterTarget('uat-eks'), 'job-1');
    expect(made).toEqual({ refused: expect.stringContaining(`(${UAT} in us-east-1, us-east-2: none; ${PROD} in us-east-1: none)`) });
  });
});

const store = (secrets: VaultSecret[], events: { type: string; data: unknown }[] = []) => ({
  vault: { list: () => secrets } as never, config: { read: () => undefined } as never, topology: { list: () => [] } as never, events: { append: (e: { type: string; data: unknown }) => { events.push(e); } } as never,
});

describe('a mint test of a cluster found in another region (issue #1845)', () => {
  it('names the account, the region, the role, the minting credential and the regions it searched', async () => {
    const f = fakeMinter({ [UAT]: ['us-east-1', 'us-east-2'] }, { [UAT]: ['us-east-2'] });
    const secrets = [aws('MINTER_UAT', UAT)];
    const r = await createMintTest({ store: store(secrets) })('cluster/uat-eks', 'admin', fromHere(f, secrets));
    expect(r).toMatchObject({
      tested: {
        kind: 'kube', credential: 'MINTER_UAT', account: UAT, region: 'us-east-2', roleArn: `arn:aws:iam::${UAT}:role/hopper-read`,
        searched: [{ account: UAT, regions: ['us-east-1', 'us-east-2'] }],
      },
    });
  });
});

describe('an EKS minting credential whose kubeconfig is gone (issue #1845)', () => {
  const stale = secret('eks-uat', { kind: 'cluster', name: 'uat-eks' });
  const eksValue = JSON.stringify({ type: 'eks', roleArn: `arn:aws:iam::${UAT}:role/hopper-read`, kubeconfig: 'kube-config' });
  const secrets = [aws('MINTER_UAT', UAT), stale];

  it('gives way to discovery, and the mint test warns of it', async () => {
    const f = fakeMinter({ [UAT]: ['us-east-1', 'us-east-2'] }, { [UAT]: ['us-east-2'] });
    const events: { type: string; data: unknown }[] = [];
    const r = await createMintTest({ store: store(secrets, events) })('cluster/uat-eks', 'admin', fromHere(f, secrets, { 'eks-uat': eksValue }));
    expect(r).toMatchObject({
      tested: {
        credential: 'MINTER_UAT', account: UAT, region: 'us-east-2',
        warning: 'the minting credential eks-uat: it names the kubeconfig kube-config, and the vault holds no secret of that name. The vault passed over it and found the cluster in the AWS accounts: fix or remove eks-uat on Vault',
      },
    });
    expect(events).toEqual([{ type: 'vault.mint_tested', data: expect.objectContaining({ credential: 'MINTER_UAT' }) }]);
  });

  it('says both reasons when discovery finds nothing either', async () => {
    const f = fakeMinter({ [UAT]: ['us-east-1'] }, {});
    const r = await createMintTest({ store: store(secrets) })('cluster/uat-eks', 'admin', fromHere(f, secrets, { 'eks-uat': eksValue }));
    expect(r).toMatchObject({ code: 'failed', refused: expect.stringMatching(/^the mint test used eks-uat: the minting credential eks-uat: it names the kubeconfig kube-config, and the vault holds no secret of that name; passed over it: no minting credential mints for cluster uat-eks, and the vault found it in none/) });
  });
});

const T0 = Date.parse('2030-01-01T00:00:00Z');
const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const failed = (asset: Asset): Template => ({
  name: 'asked-0123456789ab', image: IMAGE, secrets: [], profiles: [{ operation: 'read', asset }], readOnly: true, savedBy: 'job j', savedAt: new Date(T0 - 1000).toISOString(),
  approval: { image: IMAGE, secrets: [], by: 'the read policy', at: new Date(T0).toISOString() },
  check: { version: new Date(T0 - 1000).toISOString(), state: 'failed', at: new Date(T0).toISOString(), probes: [], unminted: [{ asset, reason: 'no minting credential mints for cluster uat-eks' }] },
});

describe('a check that failed as the vault minted nothing (issue #1845)', () => {
  it('runs again by itself CHECK_UNMINTED_MS after it failed, and says so', () => {
    const t = failed({ kind: 'cluster', name: 'uat-eks' });
    expect(dueForCheck(t, new Date(T0 + CHECK_UNMINTED_MS - 1))).toBe(false);
    expect(dueForCheck(t, new Date(T0 + CHECK_UNMINTED_MS))).toBe(true);
    expect(checkWait(t)).toContain('The hopper runs it again in an hour');
  });

  it('runs again when a minting credential for an AWS account is set, for a cluster need: discovery may find it there', () => {
    let templates = [failed({ kind: 'cluster', name: 'uat-eks' }), { ...failed({ kind: 'aws-role', name: `${PROD}/ReadOnly` }), name: 'asked-role' }];
    const events: { type: string; data: unknown }[] = [];
    const s = {
      vault: { templates: () => templates, saveTemplate: (t: Template) => { templates = templates.map((x) => (x.name === t.name ? t : x)); } } as never,
      events: { append: (e: { type: string; data: unknown }) => { events.push(e); } } as never,
    };
    recheckUnminted(s, { kind: 'aws-account', name: UAT }, 'MINTER_UAT');
    expect(events).toEqual([{ type: 'template.check_requested', data: { template: 'asked-0123456789ab', by: 'minting credential MINTER_UAT' } }]);
    expect(templates.map((t) => t.check?.state)).toEqual([undefined, 'failed']);
  });
});

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.close(r); s.closeAllConnections(); }))); });

/** EC2 on loopback: DescribeRegions answers two regions, and counts the asks. */
async function ec2Api(): Promise<{ url: string; seen: { body: string; authorization: string }[] }> {
  const seen: { body: string; authorization: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      seen.push({ body, authorization: req.headers.authorization ?? '' });
      res.writeHead(200, { 'content-type': 'text/xml' }).end(`<?xml version="1.0" encoding="UTF-8"?>
<DescribeRegionsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>r</requestId><regionInfo>
<item><regionName>us-east-1</regionName><regionEndpoint>ec2.us-east-1.amazonaws.com</regionEndpoint><optInStatus>opt-in-not-required</optInStatus></item>
<item><regionName>us-east-2</regionName><regionEndpoint>ec2.us-east-2.amazonaws.com</regionEndpoint><optInStatus>opt-in-not-required</optInStatus></item>
</regionInfo></DescribeRegionsResponse>`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe('the EC2 regions adapter', () => {
  const session = { kind: 'aws' as const, AccessKeyId: 'ASIAMINTED', SecretAccessKey: 's', SessionToken: 't', Expiration: '2030-01-01T00:15:00Z' };

  it('lists the account\'s enabled regions with the session, and keeps the answer for the account', async () => {
    const ec2 = await ec2Api();
    const minter = createCredentialMinter();
    expect(await minter.awsRegions(session, { account: UAT, region: 'us-east-1', endpoint: ec2.url })).toEqual(['us-east-1', 'us-east-2']);
    expect(await minter.awsRegions(session, { account: UAT, region: 'us-east-1', endpoint: ec2.url })).toEqual(['us-east-1', 'us-east-2']);
    expect(ec2.seen).toHaveLength(1);
    expect(ec2.seen[0]!.body).toContain('Action=DescribeRegions');
    expect(ec2.seen[0]!.authorization).toContain('Credential=ASIAMINTED/');
    expect(ec2.seen[0]!.authorization).toContain('/us-east-1/ec2/aws4_request');
    await minter.awsRegions(session, { account: PROD, region: 'us-east-1', endpoint: ec2.url });
    expect(ec2.seen).toHaveLength(2);
  });
});
