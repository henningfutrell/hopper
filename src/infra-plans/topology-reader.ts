// What reads an AWS account and a Kubernetes cluster for topology discovery (issue #1781 part 3, design.md "The
// infrastructure topology"): the `TopologyReader` port over the AWS SDK and @kubernetes/client-node, with the credential
// the vault minted (a `hopper-read` session, a read token). Read calls only: list and describe. Each list is read page by
// page, at most NODES_MAX items; a list the credential may not read is left out, and a source none of whose lists can be
// read throws the first error. The answers are in the AWS CLI's and kubectl's shapes, so the same mappers read them.
import { DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2';
import { DescribeClusterCommand, EKSClient, ListClustersCommand } from '@aws-sdk/client-eks';
import { DescribeLoadBalancersCommand, ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { IAMClient, ListRolesCommand } from '@aws-sdk/client-iam';
import { DescribeDBInstancesCommand, RDSClient } from '@aws-sdk/client-rds';
import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { AppsV1Api, CoreV1Api, KubeConfig, NetworkingV1Api } from '@kubernetes/client-node';
import type { TopologyReader } from '../domain/ports.ts';
import type { AwsAnswers, KubeAnswers, KubeObject } from '../domain/topology-discover.ts';
import { NODES_MAX } from '../domain/topology.ts';

/** What sends one AWS command: an SDK client's `send`. */
export interface AwsSender { send(command: unknown, o?: { abortSignal?: AbortSignal }): Promise<unknown>; destroy?(): void }

/** The AWS clients a read uses, made with the session and the region (and one endpoint for all, when given). */
export type AwsClients = Record<'eks' | 'ec2' | 'elb' | 'rds' | 'sqs' | 'iam', AwsSender>;

type ClientConfig = { region: string; endpoint?: string; credentials: { accessKeyId: string; secretAccessKey: string; sessionToken: string }; maxAttempts: number };

const sdkClients = (c: ClientConfig): AwsClients => ({
  eks: new EKSClient(c) as AwsSender, ec2: new EC2Client(c) as AwsSender, elb: new ElasticLoadBalancingV2Client(c) as AwsSender,
  rds: new RDSClient(c) as AwsSender, sqs: new SQSClient(c) as AwsSender, iam: new IAMClient(c) as AwsSender,
});

type Page = Record<string, unknown>;
const listOf = <T>(page: Page, key: string): T[] => (Array.isArray(page[key]) ? (page[key] as T[]) : []);
const textOf = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Every item of a paged list: `ask(token)` sends one page's command; `next` reads the next page's token. */
async function paged<T>(send: AwsSender, signal: AbortSignal, ask: (token: string | undefined) => unknown, items: string, next: (p: Page) => string | undefined): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  do {
    signal.throwIfAborted();
    const page = (await send.send(ask(token), { abortSignal: signal })) as Page;
    out.push(...listOf<T>(page, items));
    token = next(page);
  } while (token && out.length < NODES_MAX);
  return out.slice(0, NODES_MAX);
}

/** Each list read, or left out when it cannot be; the first error when none can be read. */
async function eachList<T extends object>(what: string, lists: { [K in keyof T]: () => Promise<T[K]> }): Promise<Partial<T>> {
  const keys = Object.keys(lists) as (keyof T)[];
  const read = await Promise.allSettled(keys.map((k) => lists[k]()));
  const out: Partial<T> = {};
  read.forEach((r, i) => { if (r.status === 'fulfilled') out[keys[i]!] = r.value; });
  const failed = read.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed && Object.keys(out).length === 0) throw new Error(`${what} could not be read: ${(failed.reason as Error).message ?? String(failed.reason)}`);
  return out;
}

const partitionOf = (region: string): string => (region.startsWith('cn-') ? 'aws-cn' : region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws');

/** An account in a region, read with `clients`. */
export async function readAws(clients: AwsClients, r: { account: string; region: string }, signal: AbortSignal): Promise<AwsAnswers> {
  const { eks, ec2, elb, rds, sqs, iam } = clients;
  const lists = await eachList<Omit<AwsAnswers, 'account' | 'region' | 'partition'>>(`the AWS account ${r.account} in ${r.region}`, {
    clusters: async () => {
      const names = await paged<string>(eks, signal, (nextToken) => new ListClustersCommand({ ...(nextToken ? { nextToken } : {}) }), 'clusters', (p) => textOf(p.nextToken));
      const out: NonNullable<AwsAnswers['clusters']> = [];
      for (const name of names) {
        const c = ((await eks.send(new DescribeClusterCommand({ name }), { abortSignal: signal })) as Page).cluster as Page | undefined;
        const arn = textOf(c?.arn);
        const vpcId = textOf((c?.resourcesVpcConfig as Page | undefined)?.vpcId);
        if (arn) out.push({ name, arn, ...(textOf(c?.version) ? { version: textOf(c?.version)! } : {}), ...(vpcId ? { resourcesVpcConfig: { vpcId } } : {}) });
      }
      return out;
    },
    vpcs: async () => (await paged<NonNullable<AwsAnswers['vpcs']>[number]>(ec2, signal, (NextToken) => new DescribeVpcsCommand({ ...(NextToken ? { NextToken } : {}) }), 'Vpcs', (p) => textOf(p.NextToken))).filter((v) => textOf(v.VpcId)),
    loadBalancers: async () => (await paged<NonNullable<AwsAnswers['loadBalancers']>[number]>(elb, signal, (Marker) => new DescribeLoadBalancersCommand({ ...(Marker ? { Marker } : {}) }), 'LoadBalancers', (p) => textOf(p.NextMarker))).filter((l) => textOf(l.LoadBalancerArn) && textOf(l.LoadBalancerName)),
    databases: async () => (await paged<NonNullable<AwsAnswers['databases']>[number]>(rds, signal, (Marker) => new DescribeDBInstancesCommand({ ...(Marker ? { Marker } : {}) }), 'DBInstances', (p) => textOf(p.Marker))).filter((d) => textOf(d.DBInstanceArn) && textOf(d.DBInstanceIdentifier)),
    queues: async () => paged<string>(sqs, signal, (NextToken) => new ListQueuesCommand({ ...(NextToken ? { NextToken } : {}) }), 'QueueUrls', (p) => textOf(p.NextToken)),
    roles: async () => (await paged<NonNullable<AwsAnswers['roles']>[number]>(iam, signal, (Marker) => new ListRolesCommand({ ...(Marker ? { Marker } : {}) }), 'Roles', (p) => (p.IsTruncated === true ? textOf(p.Marker) : undefined))).filter((x) => textOf(x.Arn) && textOf(x.RoleName)),
  });
  return { account: r.account, region: r.region, partition: partitionOf(r.region), ...lists };
}

/** A Kubernetes list's items as `kubectl get -o json` gives them, page by page. */
async function items(list: (_continue: string | undefined) => Promise<{ items: unknown[]; metadata?: { _continue?: string } }>, signal: AbortSignal): Promise<KubeObject[]> {
  const out: KubeObject[] = [];
  let next: string | undefined;
  do {
    signal.throwIfAborted();
    const page = await list(next);
    out.push(...(page.items as KubeObject[]).filter((o) => typeof o.metadata?.name === 'string'));
    next = page.metadata?._continue || undefined;
  } while (next && out.length < NODES_MAX);
  return out.slice(0, NODES_MAX);
}

/** A cluster read with a token: its namespaces, deployments, services, ingresses and service accounts. */
export async function readKube(r: Parameters<TopologyReader['kube']>[0], signal: AbortSignal): Promise<KubeAnswers> {
  const kc = new KubeConfig();
  // An https API server's certificate is always checked. The client takes a plain http server (one on loopback) only with
  // skipTLSVerify, which has no TLS to skip there.
  kc.loadFromOptions({
    clusters: [{ name: 'c', server: r.server, ...(r.certificateAuthorityData ? { caData: r.certificateAuthorityData } : {}), skipTLSVerify: r.server.startsWith('http:') }],
    users: [{ name: 'u', token: r.token }], contexts: [{ name: 'x', cluster: 'c', user: 'u' }], currentContext: 'x',
  });
  const core = kc.makeApiClient(CoreV1Api), apps = kc.makeApiClient(AppsV1Api), net = kc.makeApiClient(NetworkingV1Api);
  const limit = 500;
  const lists = await eachList<Omit<KubeAnswers, 'cluster' | 'name'>>(`the cluster ${r.name}`, {
    namespaces: () => items((c) => core.listNamespace({ limit, ...(c ? { _continue: c } : {}) }), signal),
    deployments: () => items((c) => apps.listDeploymentForAllNamespaces({ limit, ...(c ? { _continue: c } : {}) }), signal),
    services: () => items((c) => core.listServiceForAllNamespaces({ limit, ...(c ? { _continue: c } : {}) }), signal),
    ingresses: () => items((c) => net.listIngressForAllNamespaces({ limit, ...(c ? { _continue: c } : {}) }), signal),
    serviceAccounts: () => items((c) => core.listServiceAccountForAllNamespaces({ limit, ...(c ? { _continue: c } : {}) }), signal),
  });
  return { cluster: r.cluster, name: r.name, ...lists };
}

/** The reader. `awsClients`: what makes the AWS clients (default the SDK's), so a test sends to a fake. */
export function createTopologyReader(o: { awsClients?: (c: ClientConfig) => AwsClients } = {}): TopologyReader {
  return {
    async aws(r, signal) {
      const s = r.session;
      const clients = (o.awsClients ?? sdkClients)({
        region: r.region, ...(r.endpoint ? { endpoint: r.endpoint } : {}), maxAttempts: 2,
        credentials: { accessKeyId: s.AccessKeyId, secretAccessKey: s.SecretAccessKey, sessionToken: s.SessionToken },
      });
      try {
        return await readAws(clients, r, signal);
      } finally {
        for (const c of Object.values(clients)) c.destroy?.();
      }
    },
    kube: (r, signal) => readKube(r, signal),
  };
}
