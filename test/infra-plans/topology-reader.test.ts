// Issue #1781 part 3 (design.md "The infrastructure topology"): what topology discovery reads AWS and Kubernetes with.
// AWS: the SDK's commands sent to fake clients, page by page. Kubernetes: the real @kubernetes/client-node against a
// Kubernetes API faked on loopback, page by page, with the minted token.
//
// Feature: discovery reads an account and a cluster with read calls only
//   Scenario: every page of each AWS list is read, each EKS cluster described; a list the session may not read is left out
//   Scenario: a region that is not the home region is read without the global lists (IAM roles, S3 buckets)
//   Scenario: the regions the account has enabled are listed with the session
//   Scenario: an account none of whose lists can be read is an error that says why
//   Scenario: every page of each Kubernetes list is read with the token; a list the token may not read is left out
//   Scenario: a cluster none of whose lists can be read is an error that says why
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createTopologyReader, readAws, type AwsClients, type AwsSender } from '../../src/infra-plans/topology-reader.ts';

const SESSION = { kind: 'aws' as const, AccessKeyId: 'ASIA', SecretAccessKey: 's', SessionToken: 't', Expiration: '2030-01-01T00:00:00Z' };
const signal = new AbortController().signal;

/** A client that answers each command by its name and input; every command it got is kept. */
function fakeClient(answer: (name: string, input: Record<string, unknown>) => unknown, sent: string[]): AwsSender {
  return {
    send: async (command) => {
      const c = command as { constructor: { name: string }; input: Record<string, unknown> };
      sent.push(`${c.constructor.name} ${JSON.stringify(c.input)}`);
      return answer(c.constructor.name, c.input);
    },
  };
}

const denied = (): never => { throw Object.assign(new Error('User is not authorized to perform: iam:ListRoles'), { name: 'AccessDenied' }); };

describe('the AWS reader', () => {
  it('reads every page of each list and describes each EKS cluster; a list the session may not read is left out', async () => {
    const sent: string[] = [];
    const clients: AwsClients = {
      eks: fakeClient((n, i) => (n === 'ListClustersCommand' ? (i.nextToken ? { clusters: ['b'] } : { clusters: ['a'], nextToken: 'p2' })
        : { cluster: { name: i.name, arn: `arn:aws:eks:eu-west-1:111111111111:cluster/${String(i.name)}`, version: '1.31', resourcesVpcConfig: { vpcId: 'vpc-1' } } }), sent),
      ec2: fakeClient((_n, i) => (i.NextToken ? { Vpcs: [{ VpcId: 'vpc-2' }] } : { Vpcs: [{ VpcId: 'vpc-1' }, { CidrBlock: 'no id' }], NextToken: 'v2' }), sent),
      elb: fakeClient(() => ({ LoadBalancers: [{ LoadBalancerArn: 'arn:lb', LoadBalancerName: 'web', DNSName: 'web.elb' }] }), sent),
      rds: fakeClient(() => ({ DBInstances: [{ DBInstanceArn: 'arn:db', DBInstanceIdentifier: 'orders' }] }), sent),
      sqs: fakeClient(() => ({ QueueUrls: ['https://sqs.eu-west-1.amazonaws.com/111111111111/orders'] }), sent),
      iam: fakeClient(denied, sent),
      s3: fakeClient((_n, i) => (i.ContinuationToken ? { Buckets: [{ Name: 'logs' }] } : { Buckets: [{ Name: 'orders-data', BucketRegion: 'us-east-2', CreationDate: new Date(0) }, {}], ContinuationToken: 'b2' }), sent),
    };
    const a = await readAws(clients, { account: '111111111111', region: 'eu-west-1' }, signal);
    expect(a).toEqual({
      account: '111111111111', region: 'eu-west-1', partition: 'aws',
      clusters: [
        { name: 'a', arn: 'arn:aws:eks:eu-west-1:111111111111:cluster/a', version: '1.31', resourcesVpcConfig: { vpcId: 'vpc-1' } },
        { name: 'b', arn: 'arn:aws:eks:eu-west-1:111111111111:cluster/b', version: '1.31', resourcesVpcConfig: { vpcId: 'vpc-1' } },
      ],
      vpcs: [{ VpcId: 'vpc-1' }, { VpcId: 'vpc-2' }],
      loadBalancers: [{ LoadBalancerArn: 'arn:lb', LoadBalancerName: 'web', DNSName: 'web.elb' }],
      databases: [{ DBInstanceArn: 'arn:db', DBInstanceIdentifier: 'orders' }],
      queues: ['https://sqs.eu-west-1.amazonaws.com/111111111111/orders'],
      buckets: [{ Name: 'orders-data', BucketRegion: 'us-east-2' }, { Name: 'logs' }],
    });
    // Read calls only.
    expect(sent.every((s) => /^(List|Describe)/.test(s))).toBe(true);
    expect(sent).toContain('ListClustersCommand {"nextToken":"p2"}');
    expect(sent).toContain('ListBucketsCommand {"ContinuationToken":"b2"}');
  });

  it('reads a region that is not the home region without the global lists: no IAM roles, no S3 buckets', async () => {
    const sent: string[] = [];
    const one = fakeClient(() => ({}), sent);
    const a = await readAws({ eks: one, ec2: one, elb: one, rds: one, sqs: one, iam: one, s3: one }, { account: '111111111111', region: 'us-east-2', regional: true }, signal);
    expect(a).toMatchObject({ account: '111111111111', region: 'us-east-2' });
    expect(a).not.toHaveProperty('roles');
    expect(a).not.toHaveProperty('buckets');
    expect(sent.filter((x) => /^(ListRoles|ListBuckets)/.test(x))).toEqual([]);
  });

  it('lists the regions the account has enabled, with the session', async () => {
    const sent: string[] = [];
    const ec2 = fakeClient(() => ({ Regions: [{ RegionName: 'us-east-1' }, { RegionName: 'us-east-2' }, {}] }), sent);
    const made: unknown[] = [];
    const reader = createTopologyReader({ awsClients: (c) => { made.push(c); const one = fakeClient(() => ({}), []); return { eks: one, ec2, elb: one, rds: one, sqs: one, iam: one, s3: one }; } });
    expect(await reader.awsRegions({ account: '111111111111', region: 'us-east-1', session: SESSION }, signal)).toEqual(['us-east-1', 'us-east-2']);
    expect(sent).toEqual(['DescribeRegionsCommand {}']);
    expect(made).toEqual([expect.objectContaining({ region: 'us-east-1', credentials: { accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't' } })]);
  });

  it('says why when none of an account\'s lists can be read', async () => {
    const all = Object.fromEntries(['eks', 'ec2', 'elb', 'rds', 'sqs', 'iam', 's3'].map((k) => [k, fakeClient(denied, [])])) as AwsClients;
    await expect(readAws(all, { account: '111111111111', region: 'cn-north-1' }, signal)).rejects.toThrow('the AWS account 111111111111 in cn-north-1 could not be read: User is not authorized to perform: iam:ListRoles');
  });

  it('makes its clients with the minted session, in the region, at the one endpoint given, and lets them go after', async () => {
    const made: unknown[] = [];
    let destroyed = 0;
    const reader = createTopologyReader({
      awsClients: (c) => {
        made.push(c);
        const one = { send: async () => ({}), destroy: () => { destroyed += 1; } };
        return { eks: one, ec2: one, elb: one, rds: one, sqs: one, iam: one, s3: one };
      },
    });
    await reader.aws({ account: '111111111111', region: 'eu-west-1', endpoint: 'http://127.0.0.1:4566', session: SESSION }, signal);
    expect(made).toEqual([{ region: 'eu-west-1', endpoint: 'http://127.0.0.1:4566', maxAttempts: 2, credentials: { accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't' } }]);
    expect(destroyed).toBe(7);
  });
});

let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

/** A Kubernetes API on loopback: `lists` answers each path; a path it lacks is 403. Every request's path and token kept. */
async function fakeKube(lists: Record<string, (q: URLSearchParams) => unknown>): Promise<{ url: string; seen: { path: string; auth: string }[] }> {
  const seen: { path: string; auth: string }[] = [];
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    seen.push({ path: `${u.pathname}${u.search}`, auth: req.headers.authorization ?? '' });
    const list = lists[u.pathname];
    if (!list) { res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ kind: 'Status', status: 'Failure', reason: 'Forbidden', message: `forbidden: ${u.pathname}`, code: 403 })); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list(u.searchParams)));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

const list = (kind: string, items: unknown[], next?: string) => ({ kind, apiVersion: 'v1', metadata: next ? { continue: next } : {}, items });

describe('the Kubernetes reader', () => {
  it('reads every page of each list with the token; a list the token may not read is left out', async () => {
    const k = await fakeKube({
      '/api/v1/namespaces': (q) => (q.get('continue') ? list('NamespaceList', [{ metadata: { name: 'shop' } }]) : list('NamespaceList', [{ metadata: { name: 'default' } }], 'n2')),
      '/apis/apps/v1/deployments': () => list('DeploymentList', [{ metadata: { name: 'orders', namespace: 'shop' }, spec: { selector: {}, template: {} } }]),
      '/api/v1/services': () => list('ServiceList', [{ metadata: { name: 'orders', namespace: 'shop' }, spec: { selector: { app: 'orders' } } }]),
      '/api/v1/serviceaccounts': () => list('ServiceAccountList', [{ metadata: { name: 'orders', namespace: 'shop', annotations: { 'eks.amazonaws.com/role-arn': 'arn:aws:iam::2:role/x' } } }]),
    });
    const r = await createTopologyReader().kube({ cluster: 'arn:c', name: 'prod', server: k.url, token: 'minted-token' }, signal);
    expect(r.cluster).toBe('arn:c');
    expect(r.name).toBe('prod');
    expect(r.namespaces!.map((n) => n.metadata.name)).toEqual(['default', 'shop']);
    expect(r.deployments!.map((n) => n.metadata.name)).toEqual(['orders']);
    expect(r.services![0]!.spec).toEqual({ selector: { app: 'orders' } });
    expect(r.serviceAccounts![0]!.metadata.annotations).toEqual({ 'eks.amazonaws.com/role-arn': 'arn:aws:iam::2:role/x' });
    expect(r).not.toHaveProperty('ingresses');
    expect(k.seen.every((s) => s.auth === 'Bearer minted-token')).toBe(true);
    expect(k.seen.map((s) => s.path)).toContain('/api/v1/namespaces?continue=n2&limit=500');
  });

  it('says why when none of a cluster\'s lists can be read', async () => {
    const k = await fakeKube({});
    await expect(createTopologyReader().kube({ cluster: 'arn:c', name: 'prod', server: k.url, token: 't' }, signal)).rejects.toThrow(/^the cluster prod could not be read: /);
  });
});
