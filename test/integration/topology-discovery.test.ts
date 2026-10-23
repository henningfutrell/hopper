// Issue #1781 part 3, through the real composition root, the real HTTP server, the real database, the real saga coordinator
// and the real minting adapters (STS and the Kubernetes API faked on loopback): the hopper discovers the topology itself
// (design.md "The infrastructure topology"). What reads AWS and the cluster with the minted credentials is faked at its seam.
//
// Feature: the hopper reads its own topology with the read credentials the vault mints
//   Scenario: Discover now reads an AWS account and its cluster; the graph holds both, and the links between them
//     Given the minting credential AWS_PROD for aws-account/111111111111 in eu-west-1
//     And the minting credential KUBE_PROD for cluster/prod
//     When an operator asks for Discover now
//     Then the vault mints a read session of hopper-read and a read token for prod, and each mint is recorded with no key
//     And the reader reads the account with that session in eu-west-1, and the cluster EKS listed with that token
//     And the graph holds the account and the cluster, joined, reported by "topology discovery"
//     And it reads every region the account has enabled, the IAM roles and S3 buckets in the credential's region only
//     And the cluster EKS lists in another region is a cluster node in its account, region and VPC, and a source
//   Scenario: an account the vault mints nothing for and a cluster out of reach lose nothing of the rest of the graph
//   Scenario: a cluster entry EKS does not list and the vault mints nothing for is no source, and a source never read is forgotten
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TopologyReader } from '../../src/domain/ports.ts';
import type { TopologyGraph } from '../../src/domain/topology.ts';
import { fakeKubeApi, fakeSts, MINTED_AWS, MINTED_KUBE_TOKEN, type FakeApi } from '../support/fake-mint-apis.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { aws, CLUSTER, kube, ROLE } from '../support/topology-answers.ts';
import { KEY } from '../support/webhooks.ts';

const ACCOUNT = '111111111111';
const OTHER = '444444444444';
const UTILITY = `arn:aws:eks:us-east-2:${ACCOUNT}:cluster/utility-eks`;
const MINTING_SECRET = 'minting-secret-never-shown';
const KUBE_MINTING_TOKEN = 'kube-minting-token-never-shown';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
});

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  vi.restoreAllMocks();
});

/**
 * A reader that answers the test account in its home region, and in us-east-2 one more cluster (utility-eks, in its VPC);
 * keeps what it was asked with, and fails the cluster on demand.
 */
function fakeReader() {
  const asked: { aws: Parameters<TopologyReader['aws']>[0][]; kube: Parameters<TopologyReader['kube']>[0][] } = { aws: [], kube: [] };
  const state = { clusterDown: false };
  const reader: TopologyReader = {
    awsRegions: async () => ['us-east-2', 'eu-west-1'],
    aws: async (r) => {
      asked.aws.push(r);
      if (r.region === 'us-east-2') return { account: r.account, region: r.region, clusters: [{ name: 'utility-eks', arn: UTILITY, resourcesVpcConfig: { vpcId: 'vpc-9' } }], vpcs: [{ VpcId: 'vpc-9' }] };
      return { ...aws, account: r.account, region: r.region, buckets: [{ Name: 'orders-data', BucketRegion: 'us-east-2' }] };
    },
    kube: async (r) => {
      asked.kube.push(r);
      if (state.clusterDown) throw new Error('the Kubernetes API could not be reached: connect ECONNREFUSED');
      return { ...kube, cluster: r.cluster };
    },
  };
  return { reader, asked, state };
}

async function boot(o: { other?: boolean } = {}): Promise<{ a: TestApp; session: string; sts: FakeApi; kubeApi: FakeApi; fake: ReturnType<typeof fakeReader> }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const sts = await fakeSts(ACCOUNT);
  const kubeApi = await fakeKubeApi();
  cleanups.push(sts.close, kubeApi.close);
  const fake = fakeReader();
  t = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, seams: { topologyReader: fake.reader } });
  const session = await t.login();
  const set = async (body: Record<string, unknown>) => { expect((await t!.ui('/ui/api/vault', { action: 'set', ...body }, { token: session })).status).toBe(200); };
  await set({ name: 'AWS_PROD', mints: { kind: 'aws-account', name: ACCOUNT }, value: JSON.stringify({ AccessKeyId: 'AKIAMINTING', SecretAccessKey: MINTING_SECRET, Region: 'eu-west-1', Endpoint: sts.url }) });
  await set({ name: 'KUBE_PROD', mints: { kind: 'cluster', name: 'prod' }, value: JSON.stringify({ server: kubeApi.url, token: KUBE_MINTING_TOKEN }) });
  // An account whose STS answers nothing: the vault mints no read session for it.
  if (o.other) await set({ name: 'AWS_OTHER', mints: { kind: 'aws-account', name: OTHER }, value: JSON.stringify({ AccessKeyId: 'AKIAOTHER', SecretAccessKey: MINTING_SECRET, Region: 'us-east-1', Endpoint: 'http://127.0.0.1:1' }) });
  return { a: t, session, sts, kubeApi, fake };
}

const discover = async (a: TestApp, session: string) => {
  const r = await a.ui('/ui/api/topology/discover', {}, { token: session });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { state: string; error?: string; graph: TopologyGraph };
};

/** No key — a minting credential's, the minted session's, or a minted token — in the events or the log. */
function noKeyAnywhere(a: TestApp): void {
  const everything = [JSON.stringify(a.user().store.events.since(0, 100_000)), logged.join('\n')].join('\n');
  for (const secret of [MINTING_SECRET, KUBE_MINTING_TOKEN, MINTED_AWS.SecretAccessKey, MINTED_AWS.SessionToken, MINTED_KUBE_TOKEN]) expect(everything).not.toContain(secret);
}

describe('topology discovery inside the hopper', () => {
  it('reads an AWS account and the cluster EKS lists there with the read credentials the vault mints, into one graph', async () => {
    const { a, session, sts, kubeApi, fake } = await boot();
    const r = await discover(a, session);
    expect(r.state).toBe('done');

    // The vault minted a read session of hopper-read, and a read token for prod: read only.
    const assume = new URLSearchParams(sts.seen.find((s) => s.body.includes('AssumeRole'))!.body);
    expect(assume.get('RoleArn')).toBe(`arn:aws:iam::${ACCOUNT}:role/hopper-read`);
    expect(assume.get('RoleSessionName')).toBe('hopper-topology-discovery');
    expect(assume.get('PolicyArns.member.1.arn')).toBe('arn:aws:iam::aws:policy/ReadOnlyAccess');
    expect(kubeApi.seen.some((s) => s.url.includes('/serviceaccounts/hopper-read/token'))).toBe(true);

    // The reader read with what was minted, where the minting credentials say.
    // Every region the account has enabled; the global lists (IAM, S3) in the credential's region only.
    const readSession = expect.objectContaining({ AccessKeyId: MINTED_AWS.AccessKeyId });
    expect([...fake.asked.aws].sort((x, y) => x.region.localeCompare(y.region))).toEqual([
      { account: ACCOUNT, region: 'eu-west-1', endpoint: sts.url, session: readSession },
      { account: ACCOUNT, region: 'us-east-2', endpoint: sts.url, session: readSession, regional: true },
    ]);
    expect(fake.asked.kube).toEqual([{ cluster: CLUSTER, name: 'prod', server: kubeApi.url, token: MINTED_KUBE_TOKEN }]);

    const g = r.graph;
    // The cluster EKS lists in us-east-2 is a source too: the vault mints it no token here, so it is reported failed.
    expect(g.sources.map((s) => [s.key, s.reporter, s.lastRead.ok])).toEqual([
      [`aws/${ACCOUNT}/eu-west-1`, 'topology discovery', true], [`aws/${ACCOUNT}/us-east-2`, 'topology discovery', true],
      [`kubernetes/${CLUSTER}`, 'topology discovery', true], [`kubernetes/${UTILITY}`, 'topology discovery', false],
    ]);
    expect(g.nodes.filter((n) => n.id === CLUSTER)).toHaveLength(1);
    expect(g.nodes.find((n) => n.id === UTILITY)).toMatchObject({ kind: 'cluster', name: 'utility-eks', account: ACCOUNT, region: 'us-east-2' });
    expect(g.links).toContainEqual({ from: UTILITY, to: `arn:aws:ec2:us-east-2:${ACCOUNT}:vpc/vpc-9`, kind: 'in' });
    expect(g.nodes.find((n) => n.kind === 'bucket')).toMatchObject({ id: 'arn:aws:s3:::orders-data', account: ACCOUNT, region: 'us-east-2' });
    expect(g.links).toContainEqual({ from: 'arn:aws:s3:::orders-data', to: `aws-account:${ACCOUNT}`, kind: 'in' });
    expect(g.links).toContainEqual({ from: `k8s:${CLUSTER}/shop/serviceaccount/orders`, to: ROLE, kind: 'assumes' });
    expect(g.links).toContainEqual({ from: aws.loadBalancers![0]!.LoadBalancerArn, to: `k8s:${CLUSTER}/shop/service/orders`, kind: 'routes-to' });
    expect((await a.api<TopologyGraph>('GET', '/api/topology', undefined, { 'x-hopper-session': session })).body.sources).toEqual(g.sources);

    const minted = (await a.events()).filter((e) => e.type === 'vault.discovery_minted').map((e) => e.data);
    expect(minted).toEqual([
      { asset: { kind: 'aws-role', name: `${ACCOUNT}/hopper-read` }, credential: 'AWS_PROD', expiresAt: expect.any(String) },
      { asset: { kind: 'cluster', name: 'prod' }, credential: 'KUBE_PROD', expiresAt: expect.any(String) },
      expect.objectContaining({ asset: { kind: 'cluster', name: 'utility-eks' }, reason: expect.any(String) }),
    ]);
    expect((await a.events()).filter((e) => e.type === 'infra.topology_reported').map((e) => (e.data as { reporter: string }).reporter)).toEqual(['topology discovery', 'topology discovery']);
    expect(a.user().store.events.since(0, 100_000).filter((e) => e.type === 'vault.discovery_minted' && e.jobId)).toEqual([]);
    noKeyAnywhere(a);
  });

  it('keeps the rest of the graph when the vault mints nothing for an account and a cluster is out of reach', async () => {
    const { a, session, fake } = await boot({ other: true });
    const first = await discover(a, session);
    expect(first.state).toBe('done');
    // The other account is not read: its STS answers nothing. Its refusal is recorded; the first account and the cluster are read.
    expect([...new Set(fake.asked.aws.map((r) => r.account))]).toEqual([ACCOUNT]);
    const refused = (await a.events()).filter((e) => e.type === 'vault.discovery_minted' && (e.data as { reason?: string }).reason)
      .filter((e) => (e.data as { asset: { kind: string } }).asset.kind === 'aws-role');
    expect(refused.map((e) => (e.data as { asset: unknown; credential: string }))).toEqual([expect.objectContaining({ asset: { kind: 'aws-role', name: `${OTHER}/hopper-read` }, credential: 'AWS_OTHER' })]);
    const before = first.graph.sources.find((s) => s.key === `kubernetes/${CLUSTER}`)!.lastGood!;

    // The next run, the cluster does not answer: its snapshot stays, with why; the account is read again.
    fake.state.clusterDown = true;
    const second = await discover(a, session);
    expect(second.state).toBe('done');
    const cluster = second.graph.sources.find((s) => s.key === `kubernetes/${CLUSTER}`)!;
    expect(cluster).toMatchObject({ lastGood: before, lastRead: { ok: false, error: 'the Kubernetes API could not be reached: connect ECONNREFUSED' } });
    expect(second.graph.sources.find((s) => s.key === `aws/${ACCOUNT}/eu-west-1`)!.lastRead.ok).toBe(true);
    expect(second.graph.nodes.map((n) => n.id).sort()).toEqual(first.graph.nodes.map((n) => n.id).sort());
    expect(second.graph.links).toContainEqual({ from: `k8s:${CLUSTER}/shop/serviceaccount/orders`, to: ROLE, kind: 'assumes' });
    noKeyAnywhere(a);
  });

  it('reads no cluster source for a cluster entry EKS does not list and the vault mints nothing for, and forgets one never read', async () => {
    const { a, session } = await boot();
    const set = async (body: Record<string, unknown>) => { expect((await a.ui('/ui/api/vault', { action: 'set', ...body }, { token: session })).status).toBe(200); };
    // Stale entries: clusters EKS does not list, whose API server is gone.
    await set({ name: 'KUBE_STALE', mints: { kind: 'cluster', name: 'utility' }, value: JSON.stringify({ server: 'http://127.0.0.1:1', token: KUBE_MINTING_TOKEN }) });
    await set({ name: 'KUBE_OLD', mints: { kind: 'cluster', name: 'old' }, value: JSON.stringify({ server: 'http://127.0.0.1:1', token: KUBE_MINTING_TOKEN }) });
    const store = a.user().store.topology;
    const kept = (cluster: string, reporter: string, good: boolean) => store.put({
      key: `kubernetes/${cluster}`, source: { kind: 'kubernetes', cluster }, reporter, lastRead: { at: '2026-10-17T00:00:00.000Z', ok: good },
      ...(good ? { lastGood: { at: '2026-10-17T00:00:00.000Z', nodes: [{ id: cluster, kind: 'cluster', name: cluster }], links: [] } } : {}),
    });
    kept('utility-identity-edit', 'topology discovery', false);
    kept('old', 'topology discovery', true);
    kept('lab', 'a check', false);

    const r = await discover(a, session);
    expect(r.state).toBe('done');
    const keys = r.graph.sources.map((s) => s.key);
    // The stale entry is no source, and the discovery source that never held a snapshot is gone; a check's source stays.
    expect(keys).not.toContain('kubernetes/utility');
    expect(keys).not.toContain('kubernetes/utility-identity-edit');
    expect(keys).toContain('kubernetes/lab');
    // A cluster that once read keeps its snapshot, and says why it is not read now.
    expect(r.graph.sources.find((s) => s.key === 'kubernetes/old')).toMatchObject({ lastGood: { nodes: 1 }, lastRead: { ok: false, error: expect.stringContaining('the vault minted no read token') } });
    expect(keys).toContain(`kubernetes/${UTILITY}`);
  });

  it('takes no body fields', async () => {
    const { a, session } = await boot();
    expect((await a.ui('/ui/api/topology/discover', { more: true }, { token: session })).status).toBe(400);
  });
});
