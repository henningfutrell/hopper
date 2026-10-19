// Issue #1956 (acceptance criterion 5): drift, as topology discovery sees it, against a mock AWS (moto) behind the
// policy-assert proxy. The hopper's real discovery (design.md "The infrastructure topology") mints a read session of the
// account's `hopper-read` role through the real STS adapter and reads the account with the real AWS SDK reader, in every
// region moto lists. A change made out of band — not through the hopper — shows in the next discovery's graph, and every
// call discovery made was a read: the proxy's log of its session holds Describe, List and Get calls only, each allowed.
//
// Feature: discovery reports what changed in the account, and only reads it
//   Scenario: an out-of-band change
//     Given the minting credential AWS_LAB for the seed's account, and the role hopper-read in it
//     When an operator asks for Discover now
//     Then the graph holds the account's seeded bucket and the VPCs, reported by "topology discovery"
//     When a bucket and a VPC are made in moto out of band
//     And an operator asks for Discover now again
//     Then the graph holds the new bucket and the new VPC
//     And each call of discovery's session was a Describe, a List or a Get, and moto's state is what the change left
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { CreateVpcCommand, EC2Client } from '@aws-sdk/client-ec2';
import { EKS_READ_ROLE } from '../../src/domain/cluster-discovery.ts';
import type { TopologyGraph } from '../../src/domain/topology.ts';
import type { TestApp } from '../support/app.ts';
import { cloudHopper } from './support/hopper.ts';
import { ACCOUNT, BUCKET, REGION, SEED_KEYS, startMoto, stateHash, type Moto } from './support/moto.ts';

const OUT_OF_BAND_BUCKET = 'made-out-of-band';

let moto: Moto;
const h = cloudHopper();

beforeAll(async () => { moto = await startMoto(); }, 180_000);
afterAll(async () => { await moto?.stop(); });
afterEach(() => h.end());

async function discover(a: TestApp, session: string): Promise<TopologyGraph> {
  const r = await a.ui<{ state: string; error?: string; graph: TopologyGraph }>('/ui/api/topology/discover', {}, { token: session });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.state, r.body.error).toBe('done');
  return r.body.graph;
}

const ids = (g: TopologyGraph, kind: string): string[] => g.nodes.filter((n) => n.kind === kind).map((n) => n.id).sort();

describe('drift: topology discovery against a mock AWS behind the policy-assert proxy (issue #1956)', () => {
  it('reports an out-of-band change in the next discovery, and makes only read calls', async () => {
    const { a, session, proxy } = await h.boot(moto.url);
    const before = await discover(a, session);
    expect(before.sources.filter((s) => s.key.startsWith(`aws/${ACCOUNT}/`)).every((s) => s.reporter === 'topology discovery')).toBe(true);
    expect(before.sources.find((s) => s.key === `aws/${ACCOUNT}/${REGION}`)?.lastRead.ok).toBe(true);
    expect(ids(before, 'bucket')).toEqual([`arn:aws:s3:::${BUCKET}`]);
    const vpcsBefore = ids(before, 'vpc');
    expect(vpcsBefore.length).toBeGreaterThan(0);

    // Out of band: the seed's key, not the hopper, makes a bucket and a VPC.
    const config = { endpoint: proxy.url, region: REGION, credentials: SEED_KEYS, maxAttempts: 1 };
    const s3 = new S3Client({ ...config, forcePathStyle: true });
    const ec2 = new EC2Client(config);
    let vpc: string;
    try {
      await s3.send(new CreateBucketCommand({ Bucket: OUT_OF_BAND_BUCKET }));
      vpc = (await ec2.send(new CreateVpcCommand({ CidrBlock: '10.19.0.0/16' }))).Vpc!.VpcId!;
    } finally {
      s3.destroy();
      ec2.destroy();
    }
    const changed = await stateHash(proxy.url);

    const after = await discover(a, session);
    expect(ids(after, 'bucket')).toEqual([`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${OUT_OF_BAND_BUCKET}`].sort());
    const vpcsAfter = ids(after, 'vpc');
    expect(vpcsAfter.filter((v) => !vpcsBefore.includes(v))).toEqual([`arn:aws:ec2:${REGION}:${ACCOUNT}:vpc/${vpc}`]);
    expect((await a.events()).filter((e) => e.type === 'infra.topology_reported').length).toBeGreaterThanOrEqual(2);

    // Discovery only read: every call of its session was a Describe, a List or a Get, and each was allowed.
    const discovery = [...proxy.sessions.values()].filter((s) => s.roleArn === `arn:aws:iam::${ACCOUNT}:role/${EKS_READ_ROLE}`).map((s) => s.accessKeyId);
    expect(discovery.length).toBeGreaterThanOrEqual(2);
    const calls = proxy.log.filter((d) => d.accessKeyId !== undefined && discovery.includes(d.accessKeyId));
    expect(calls.length).toBeGreaterThan(0);
    const notRead = calls.filter((d) => !/^[a-z0-9-]+:(Describe|List|Get)[A-Za-z]*$/.test(d.action ?? '') || !d.allowed);
    expect(notRead, JSON.stringify(notRead.slice(0, 5))).toEqual([]);
    expect(new Set(calls.map((d) => d.action))).toEqual(new Set([
      'ec2:DescribeRegions', 'ec2:DescribeVpcs', 'eks:ListClusters', 'elasticloadbalancing:DescribeLoadBalancers', 'rds:DescribeDBInstances',
      'sqs:ListQueues', 'iam:ListRoles', 's3:ListAllMyBuckets',
    ]));
    expect(await stateHash(proxy.url)).toBe(changed);
  }, 300_000);
});
