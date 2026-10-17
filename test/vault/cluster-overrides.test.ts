// Issue #1766 part 2: cluster overrides, the config record `clusters`, not a vault secret. An override names a cluster's
// name in EKS (an alias), the one account and the region to look in, and the IAM role a write signs in as. The pure
// record check, the source choice with an override, and the discovery mint with a fake minter: a region, a write role.
import { describe, expect, it } from 'vitest';
import { clustersOf, clustersProblem } from '../../src/domain/clusters.ts';
import { mintSourceFor } from '../../src/domain/cluster-discovery.ts';
import { mintTarget, type CredentialMinter, type EksCluster, type MintTarget } from '../../src/domain/minting.ts';
import type { Asset } from '../../src/domain/access.ts';
import type { VaultSecret } from '../../src/domain/vault.ts';
import { mintHere } from '../../src/vault/mint.ts';
import { readClusters, writeClusters } from '../../src/vault/clusters.ts';

const UAT = '111111111111';
const PROD = '222222222222';

const secret = (name: string, mints?: Asset): VaultSecret => ({
  id: `id-${name}`, name, setBy: 'admin', createdAt: '2030-01-01T00:00:00Z', changedBy: 'admin', changedAt: '2030-01-01T00:00:00Z', ...(mints ? { mints } : {}),
});
const aws = (name: string, account: string): VaultSecret => secret(name, { kind: 'aws-account', name: account });
const secrets = [aws('MINTER_UAT', UAT), aws('MINTER_PROD', PROD)];
const cluster = (name: string, operation: 'read' | 'write' = 'read'): MintTarget => mintTarget('kube', { operation, asset: { kind: 'cluster', name } }) as MintTarget;

describe('the clusters record', () => {
  it('takes overrides with a name and optional fields', () => {
    const value = { clusters: [{ name: 'uat-identity-edit', eksName: 'uat', account: UAT, region: 'eu-west-1', writeRole: 'hopper-identity-edit' }, { name: 'prod' }] };
    expect(clustersProblem(value)).toBeUndefined();
    expect(clustersOf(value)).toEqual(value.clusters);
    expect(clustersOf(undefined)).toEqual([]);
  });

  it.each([
    [{ hosts: [] }, 'the cluster overrides are { "clusters": [...] }'],
    [{ clusters: [{ name: 'uat', secret: 'x' }] }, 'a cluster override has no field secret'],
    [{ clusters: [{ name: 'uat.lab' }] }, 'a cluster override\'s name is a cluster name'],
    [{ clusters: [{ name: 'uat', account: '12' }] }, 'cluster uat: account is an AWS account id, 12 digits'],
    [{ clusters: [{ name: 'uat', region: 'Europe' }] }, 'cluster uat: region is an AWS region'],
    [{ clusters: [{ name: 'uat', writeRole: `arn:aws:iam::${UAT}:role/x` }] }, 'cluster uat: writeRole is an IAM role name (no path, no ARN)'],
    [{ clusters: [{ name: 'uat', writeRole: 'hopper-read' }] }, 'not the read role hopper-read'],
    [{ clusters: [{ name: 'uat' }, { name: 'uat' }] }, 'two cluster overrides are named uat'],
  ])('refuses %j', (value, why) => {
    expect(clustersProblem(value)).toContain(why);
    expect(clustersOf(value)).toEqual([]);
  });

  it('is written against its version, with empty fields dropped', () => {
    let stored: unknown;
    let version = 'missing';
    const config = {
      read: () => stored, version: () => version,
      write: (_n: string, v: unknown, at: string) => { if (at !== version) return false; stored = v; version = 'v2'; return true; },
    } as never;
    expect(writeClusters(config, [{ name: 'uat', eksName: ' ', region: 'eu-west-1 ' }], 'missing')).toEqual({ ok: true, view: { clusters: [{ name: 'uat', region: 'eu-west-1' }], version: 'v2' } });
    expect(readClusters(config)).toEqual([{ name: 'uat', region: 'eu-west-1' }]);
    expect(writeClusters(config, [], 'missing')).toMatchObject({ ok: false, code: 'conflict' });
    expect(writeClusters(config, [{ name: 'uat', account: 'x' }], 'v2')).toMatchObject({ ok: false, code: 'invalid', error: expect.stringContaining('account') });
  });
});

describe('where the vault mints a cluster with an override from', () => {
  it('finds the cluster by its EKS name, in the one account and the region the override names', () => {
    expect(mintSourceFor(secrets, cluster('uat-view'), 'read', [{ name: 'uat-view', eksName: 'uat', account: PROD, region: 'eu-west-1' }])).toEqual({
      discover: { cluster: 'uat', role: 'hopper-read', credentials: [{ name: 'MINTER_PROD', account: PROD }], region: 'eu-west-1' },
    });
    // Another cluster's override changes nothing.
    expect(mintSourceFor(secrets, cluster('uat'), 'read', [{ name: 'other', eksName: 'x' }])).toMatchObject({ discover: { cluster: 'uat', credentials: [{ account: UAT }, { account: PROD }] } });
  });

  it('finds a write as the override\'s write role, and no write without one', () => {
    const edit = [{ name: 'uat-identity-edit', eksName: 'uat', writeRole: 'hopper-identity-edit' }];
    expect(mintSourceFor(secrets, cluster('uat-identity-edit', 'write'), 'write', edit)).toMatchObject({ discover: { cluster: 'uat', role: 'hopper-identity-edit' } });
    // A read of the same cluster still signs in as the read role.
    expect(mintSourceFor(secrets, cluster('uat-identity-edit'), 'read', edit)).toMatchObject({ discover: { role: 'hopper-read' } });
    expect(mintSourceFor(secrets, cluster('uat', 'write'), 'write', [{ name: 'uat', eksName: 'uat' }])).toMatch(/write needs the role its write is granted to \(writeRole in the cluster's override on Settings → Clusters\)/);
  });

  it('says so when the override\'s account has no minting credential', () => {
    expect(mintSourceFor(secrets, cluster('uat'), 'read', [{ name: 'uat', account: '333333333333' }])).toMatch(/no minting credential mints for aws-account 333333333333, the one account its cluster override names/);
  });

  it('lets the cluster\'s own minting credential win over its override', () => {
    const own = secret('eks-uat', { kind: 'cluster', name: 'uat' });
    expect(mintSourceFor([...secrets, own], cluster('uat', 'write'), 'write', [{ name: 'uat', writeRole: 'hopper-identity-edit' }])).toEqual({ credential: own });
  });
});

interface Fake { minter: CredentialMinter; assumed: string[]; described: string[] }

/** A minter that assumes any role, and has the cluster `uat` in the account `has`. */
function fakeMinter(has: string): Fake {
  const fake: Fake = { assumed: [], described: [], minter: undefined as unknown as CredentialMinter };
  fake.minter = {
    async awsSession(_c, r) {
      fake.assumed.push(r.roleArn);
      return { kind: 'aws', AccessKeyId: `ASIA-${r.roleArn}`, SecretAccessKey: 's', SessionToken: 't', Expiration: '2030-01-01T00:15:00Z' };
    },
    async eksCluster(session, r): Promise<EksCluster | undefined> {
      const account = /::(\d{12}):/.exec(session.AccessKeyId)![1]!;
      fake.described.push(`${account} ${r.region} ${r.cluster}`);
      return account === has ? { cluster: r.cluster, region: r.region, server: 'https://uat.eks', certificateAuthorityData: 'Q0E=' } : undefined;
    },
    async eksToken(session, r) { return { kind: 'kube', token: `eks:${session.AccessKeyId}:${r.cluster}`, expirationTimestamp: '2030-01-01T00:14:00Z' }; },
    async kubeIdentity() { throw new Error('not asked'); },
    async kubeToken() { throw new Error('no TokenRequest for a discovered cluster'); },
    async kubeUnbind() { throw new Error('no unbind'); },
    async awsCallerIdentity() { throw new Error('not asked'); },
  };
  return fake;
}

const keys = JSON.stringify({ AccessKeyId: 'AKIA', SecretAccessKey: 'never-shown', Region: 'us-east-2' });
const fromHere = (f: Fake) => mintHere({ vault: { get: (n) => secrets.find((s) => s.name === n), list: () => secrets }, minter: f.minter, valueOf: async () => ({ value: keys }) });
const credentials = [{ name: 'MINTER_UAT', account: UAT }, { name: 'MINTER_PROD', account: PROD }];

describe('a discovery mint with an override', () => {
  it('looks in the override\'s region in place of the credential\'s', async () => {
    const f = fakeMinter(UAT);
    await fromHere(f)({ cluster: 'uat', role: 'hopper-read', credentials, region: 'eu-west-1' }, cluster('uat'), 'job-1');
    expect(f.described).toEqual([`${UAT} eu-west-1 uat`, `${PROD} eu-west-1 uat`]);
  });

  it('finds the cluster as hopper-read, then signs a write\'s token with a session of the write role in that account', async () => {
    const f = fakeMinter(PROD);
    const made = await fromHere(f)({ cluster: 'uat', role: 'hopper-identity-edit', credentials }, cluster('uat-identity-edit', 'write'), 'job-1');
    const edit = `arn:aws:iam::${PROD}:role/hopper-identity-edit`;
    expect(f.assumed).toEqual([`arn:aws:iam::${UAT}:role/hopper-read`, `arn:aws:iam::${PROD}:role/hopper-read`, edit]);
    expect(made).toMatchObject({ minted: { token: `eks:ASIA-${edit}:uat` }, roleArn: edit, sessionName: 'hopper-job-1', credential: 'MINTER_PROD', account: PROD });
  });
});
