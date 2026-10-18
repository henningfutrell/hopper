// The infrastructure topology (issue #1781, src/domain/topology.ts and topology-discover.ts), pure: what AWS and the
// Kubernetes API answer, as nodes and links; the sources joined into one graph across AWS and Kubernetes; a source that
// could not be read keeps its last good snapshot; a report that is not whole is refused.
import { describe, expect, it } from 'vitest';
import { awsTopology, kubeTopology, namedEndpoints, trustedPrincipals } from '../../src/domain/topology-discover.ts';
import { aws, CLUSTER, DB_HOST, kube, QUEUE, ROLE } from '../support/topology-answers.ts';
import { afterReport, joinGraph, sourceKey, sourceReportProblem, type SourceReport, type TopologySource } from '../../src/domain/topology.ts';

const AT = '2026-10-17T10:00:00.000Z';
const report = (r: SourceReport, was?: TopologySource): TopologySource => afterReport(was, r, 'collector', AT);
const good = (): TopologySource[] => [
  report({ source: { kind: 'aws', account: '111111111111', region: 'eu-west-1' }, ok: true, ...awsTopology(aws) }),
  report({ source: { kind: 'kubernetes', cluster: CLUSTER }, ok: true, ...kubeTopology(kube) }),
];
const has = (g: ReturnType<typeof joinGraph>, from: string, kind: string, to: string): boolean => g.links.some((l) => l.from === from && l.kind === kind && l.to === to);
const k8s = (path: string): string => `k8s:${CLUSTER}/${path}`;

describe('the infrastructure topology', () => {
  it('joins an AWS account and a Kubernetes cluster into one graph', () => {
    const g = joinGraph(good());
    const cluster = g.nodes.filter((n) => n.id === CLUSTER);
    expect(cluster).toHaveLength(1);
    expect(cluster[0]!.sources).toEqual(['aws/111111111111/eu-west-1', `kubernetes/${CLUSTER}`]);
    expect(cluster[0]!.attrs).toMatchObject({ version: '1.31', platform: 'eks' });
    const vpc = 'arn:aws:ec2:eu-west-1:111111111111:vpc/vpc-1';
    expect(has(g, CLUSTER, 'in', vpc)).toBe(true);
    expect(has(g, vpc, 'in', 'aws-account:111111111111')).toBe(true);
    expect(has(g, k8s('shop'), 'in', CLUSTER)).toBe(true);
    expect(has(g, k8s('shop/deployment/orders'), 'in', k8s('shop'))).toBe(true);
  });

  it('gives an EKS cluster its account, region and VPC, and an S3 bucket its account and the region S3 names', () => {
    const t = awsTopology({ ...aws, buckets: [{ Name: 'orders-data', BucketRegion: 'us-east-2' }, { Name: 'logs' }] });
    expect(t.nodes.find((n) => n.id === CLUSTER)).toMatchObject({ kind: 'cluster', name: 'prod', account: '111111111111', region: 'eu-west-1' });
    expect(t.links).toContainEqual({ from: CLUSTER, to: 'arn:aws:ec2:eu-west-1:111111111111:vpc/vpc-1', kind: 'in' });
    expect(t.nodes.filter((n) => n.kind === 'bucket')).toEqual([
      { id: 'arn:aws:s3:::orders-data', kind: 'bucket', name: 'orders-data', account: '111111111111', region: 'us-east-2' },
      { id: 'arn:aws:s3:::logs', kind: 'bucket', name: 'logs', account: '111111111111' },
    ]);
    expect(t.links).toContainEqual({ from: 'arn:aws:s3:::orders-data', to: 'aws-account:111111111111', kind: 'in' });
    expect(sourceReportProblem({ source: { kind: 'aws', account: '111111111111', region: 'eu-west-1' }, ok: true, ...t })).toBeUndefined();
  });

  it('links a service to the load balancer in front of it, and a workload to the database and queue it names', () => {
    const g = joinGraph(good());
    expect(has(g, aws.loadBalancers![0]!.LoadBalancerArn, 'routes-to', k8s('shop/service/orders'))).toBe(true);
    expect(has(g, k8s('shop/service/orders'), 'selects', k8s('shop/deployment/orders'))).toBe(true);
    expect(has(g, k8s('shop/ingress/web'), 'routes-to', k8s('shop/service/orders'))).toBe(true);
    expect(has(g, k8s('shop/deployment/orders'), 'runs-as', k8s('shop/serviceaccount/orders'))).toBe(true);
    expect(has(g, k8s('shop/deployment/orders'), 'uses', 'arn:aws:rds:eu-west-1:111111111111:db:orders')).toBe(true);
    expect(has(g, k8s('shop/deployment/orders'), 'uses', 'arn:aws:sqs:eu-west-1:111111111111:orders')).toBe(true);
    // A host name no source read is no node.
    expect(g.nodes.some((n) => n.id.includes('other.us-east-1'))).toBe(false);
    expect(g.links.every((l) => g.nodes.some((n) => n.id === l.from) && g.nodes.some((n) => n.id === l.to))).toBe(true);
  });

  it('links a workload\'s service account to its IAM role (IRSA), and a trust across accounts, with nodes no source read', () => {
    const g = joinGraph(good());
    expect(has(g, k8s('shop/serviceaccount/orders'), 'assumes', ROLE)).toBe(true);
    expect(g.nodes.find((n) => n.id === ROLE)).toMatchObject({ kind: 'iam-role', name: 'orders-irsa', account: '222222222222', seen: false, sources: [] });
    expect(has(g, 'aws-account:333333333333', 'can-assume', 'arn:aws:iam::111111111111:role/deploy')).toBe(true);
    expect(g.nodes.find((n) => n.id === 'aws-account:333333333333')).toMatchObject({ kind: 'aws-account', seen: false });
  });

  it('a source that cannot be read keeps its last good snapshot and says why; the rest of the graph stays', () => {
    const [awsSource, kubeSource] = good();
    const failed = afterReport(kubeSource, { source: { kind: 'kubernetes', cluster: CLUSTER }, ok: false, error: 'the API server did not answer' }, 'collector', '2026-10-17T11:00:00.000Z');
    expect(failed.lastGood?.at).toBe(AT);
    expect(failed.lastRead).toEqual({ at: '2026-10-17T11:00:00.000Z', ok: false, error: 'the API server did not answer' });
    const g = joinGraph([awsSource!, failed]);
    expect(g.nodes.some((n) => n.id === k8s('shop/deployment/orders'))).toBe(true);
    expect(g.sources.find((s) => s.key === `kubernetes/${CLUSTER}`)).toMatchObject({ lastGood: { at: AT }, lastRead: { ok: false } });
    // A source never read well has no snapshot, and adds nothing.
    const never = afterReport(undefined, { source: { kind: 'aws', account: '444444444444', region: 'us-east-1' }, ok: false, error: 'AccessDenied' }, 'collector', AT);
    expect(never.lastGood).toBeUndefined();
    expect(joinGraph([never]).nodes).toEqual([]);
  });

  it('refuses a report that is not whole, and says why', () => {
    const ok = { source: { kind: 'aws', account: '111111111111', region: 'eu-west-1' }, ok: true, nodes: [], links: [] };
    expect(sourceReportProblem(ok)).toBeUndefined();
    expect(sourceReportProblem({ ...ok, source: { kind: 'aws', account: '12', region: 'eu-west-1' } })).toMatch(/12 digits/);
    expect(sourceReportProblem({ ...ok, source: { kind: 'gcp' } })).toMatch(/source kind/);
    expect(sourceReportProblem({ ...ok, nodes: [{ id: 'x', kind: 'lambda', name: 'x' }] })).toMatch(/kind must be one of/);
    expect(sourceReportProblem({ ...ok, nodes: [{ id: 'dns:x', kind: 'vpc', name: 'x' }] })).toMatch(/not an alias/);
    expect(sourceReportProblem({ ...ok, links: [{ from: 'a', to: 'b', kind: 'calls' }] })).toMatch(/kind must be one of/);
    expect(sourceReportProblem({ source: ok.source, ok: false })).toMatch(/says why/);
    expect(sourceKey({ kind: 'kubernetes', cluster: CLUSTER })).toBe(`kubernetes/${CLUSTER}`);
  });

  it('reads trust policies and the endpoints a workload names', () => {
    expect(trustedPrincipals({ Statement: [{ Effect: 'Allow', Principal: { AWS: ['123456789012', 'arn:aws:iam::222222222222:role/ci'] } }, { Effect: 'Deny', Principal: { AWS: '999999999999' } }] }))
      .toEqual(['aws-account:123456789012', 'arn:aws:iam::222222222222:role/ci']);
    expect(trustedPrincipals('not json')).toEqual([]);
    expect(namedEndpoints(`jdbc:postgresql://${DB_HOST.toUpperCase()}:5432 and ${QUEUE}`)).toEqual([`url:${QUEUE}`, `dns:${DB_HOST}`]);
  });
});
