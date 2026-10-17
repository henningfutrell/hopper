// Discovery's pure half (issue #1781, design.md "The infrastructure topology"): what AWS and the Kubernetes API answer a
// read-only check, as the nodes and links of one topology source. The input is their answers as they give them — the AWS
// CLI's JSON (the SDK's shapes), `kubectl get -o json`'s items —, so a check outside the hopper and a discovery run inside
// it map the same way. Read-only: nothing here asks anything; it reads what was asked. Pure.
import type { LinkKind, NodeKind, TopologyLink, TopologyNode } from './topology.ts';

/** What one AWS account in one region answered. Each list is optional: a check reads what its role may read. */
export interface AwsAnswers {
  account: string;
  region: string;
  partition?: string;
  /** `eks describe-cluster`'s `cluster`, for each cluster. */
  clusters?: { name: string; arn: string; version?: string; resourcesVpcConfig?: { vpcId?: string } }[];
  /** `ec2 describe-vpcs`'s `Vpcs`. */
  vpcs?: { VpcId: string; CidrBlock?: string; IsDefault?: boolean; Tags?: { Key: string; Value: string }[] }[];
  /** `elbv2 describe-load-balancers`'s `LoadBalancers`. */
  loadBalancers?: { LoadBalancerArn: string; LoadBalancerName: string; DNSName?: string; VpcId?: string; Type?: string; Scheme?: string }[];
  /** `rds describe-db-instances`'s `DBInstances`. */
  databases?: { DBInstanceArn: string; DBInstanceIdentifier: string; Engine?: string; Endpoint?: { Address?: string; Port?: number }; DBSubnetGroup?: { VpcId?: string } }[];
  /** `sqs list-queues`'s `QueueUrls`. */
  queues?: string[];
  /** `iam list-roles`'s `Roles`: global, so each region's report names the same roles; they are one node. */
  roles?: { Arn: string; RoleName: string; AssumeRolePolicyDocument?: unknown }[];
}

/** What one Kubernetes cluster answered: each list `kubectl get <kind> -A -o json`'s `items`. */
export interface KubeAnswers {
  /** The cluster node's id: an EKS cluster's ARN, so it joins the cluster AWS reported. */
  cluster: string;
  name?: string;
  namespaces?: KubeObject[];
  deployments?: KubeObject[];
  services?: KubeObject[];
  ingresses?: KubeObject[];
  serviceAccounts?: KubeObject[];
}

/** A Kubernetes object as `kubectl get -o json` gives it; only the fields discovery reads. */
export interface KubeObject {
  metadata: { name: string; namespace?: string; annotations?: Record<string, string>; labels?: Record<string, string> };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
}

/** The annotation that names a service account's IAM role (IRSA). */
export const IRSA_ANNOTATION = 'eks.amazonaws.com/role-arn';

const accountId = (account: string): string => `aws-account:${account}`;
const tagName = (tags: { Key: string; Value: string }[] | undefined): string | undefined => tags?.find((t) => t.Key === 'Name')?.Value;
const attrsOf = (o: Record<string, string | number | boolean | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));

/** The queue's ARN from its URL: `https://sqs.<region>.amazonaws.com/<account>/<name>`. */
function queueArn(url: string, partition: string): { arn: string; name: string; region: string; account: string } | undefined {
  const m = /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/(\d{12})\/([\w.-]+)$/.exec(url);
  return m ? { arn: `arn:${partition}:sqs:${m[1]}:${m[2]}:${m[3]}`, region: m[1]!, account: m[2]!, name: m[3]! } : undefined;
}

/** The AWS principals a role's trust policy lets assume it: roles by their ARN, accounts by `aws-account:<id>`. */
export function trustedPrincipals(doc: unknown): string[] {
  let policy = doc;
  if (typeof policy === 'string') {
    try { policy = JSON.parse(decodeURIComponent(policy)); } catch { return []; }
  }
  const statements = (policy as { Statement?: unknown } | null)?.Statement;
  const list = Array.isArray(statements) ? statements : statements ? [statements] : [];
  const out = new Set<string>();
  for (const s of list as { Effect?: string; Principal?: { AWS?: string | string[] } }[]) {
    if (s.Effect !== 'Allow') continue;
    const aws = s.Principal?.AWS;
    for (const p of Array.isArray(aws) ? aws : aws ? [aws] : []) {
      if (/^\d{12}$/.test(p)) { out.add(accountId(p)); continue; }
      const root = /^arn:[\w-]+:iam::(\d{12}):root$/.exec(p);
      if (root) { out.add(accountId(root[1]!)); continue; }
      if (/^arn:[\w-]+:iam::\d{12}:role\//.test(p)) out.add(p);
    }
  }
  return [...out];
}

/** The nodes and links of one AWS account in one region. */
export function awsTopology(a: AwsAnswers): { nodes: TopologyNode[]; links: TopologyLink[] } {
  const partition = a.partition ?? 'aws';
  const where = { account: a.account, region: a.region };
  const nodes: TopologyNode[] = [{ id: accountId(a.account), kind: 'aws-account', name: a.account, account: a.account }];
  const links: TopologyLink[] = [];
  const link = (from: string, to: string, kind: LinkKind): void => { links.push({ from, to, kind }); };
  const vpcArn = (id: string): string => `arn:${partition}:ec2:${a.region}:${a.account}:vpc/${id}`;
  const inVpcOrAccount = (id: string, vpc: string | undefined): void => link(id, vpc ? vpcArn(vpc) : accountId(a.account), 'in');
  for (const v of a.vpcs ?? []) {
    const id = vpcArn(v.VpcId);
    nodes.push({ id, kind: 'vpc', name: tagName(v.Tags) ?? v.VpcId, ...where, attrs: attrsOf({ vpcId: v.VpcId, cidr: v.CidrBlock, default: v.IsDefault }) });
    link(id, accountId(a.account), 'in');
  }
  for (const c of a.clusters ?? []) {
    nodes.push({ id: c.arn, kind: 'cluster', name: c.name, ...where, attrs: attrsOf({ version: c.version, platform: 'eks' }) });
    inVpcOrAccount(c.arn, c.resourcesVpcConfig?.vpcId);
  }
  for (const lb of a.loadBalancers ?? []) {
    nodes.push({
      id: lb.LoadBalancerArn, kind: 'load-balancer', name: lb.LoadBalancerName, ...where, ...(lb.DNSName ? { aliases: [`dns:${lb.DNSName.toLowerCase()}`] } : {}),
      attrs: attrsOf({ type: lb.Type, scheme: lb.Scheme, dnsName: lb.DNSName }),
    });
    inVpcOrAccount(lb.LoadBalancerArn, lb.VpcId);
  }
  for (const d of a.databases ?? []) {
    const host = d.Endpoint?.Address?.toLowerCase();
    nodes.push({
      id: d.DBInstanceArn, kind: 'database', name: d.DBInstanceIdentifier, ...where, ...(host ? { aliases: [`dns:${host}`] } : {}),
      attrs: attrsOf({ engine: d.Engine, endpoint: host, port: d.Endpoint?.Port }),
    });
    inVpcOrAccount(d.DBInstanceArn, d.DBSubnetGroup?.VpcId);
  }
  for (const url of a.queues ?? []) {
    const q = queueArn(url, partition);
    if (!q) continue;
    nodes.push({ id: q.arn, kind: 'queue', name: q.name, account: q.account, region: q.region, aliases: [`url:${url}`], attrs: { url } });
    link(q.arn, accountId(q.account), 'in');
  }
  for (const r of a.roles ?? []) {
    nodes.push({ id: r.Arn, kind: 'iam-role', name: r.RoleName, account: a.account });
    link(r.Arn, accountId(a.account), 'in');
    for (const p of trustedPrincipals(r.AssumeRolePolicyDocument)) if (p !== r.Arn) link(p, r.Arn, 'can-assume');
  }
  return { nodes, links };
}

const k8sId = (cluster: string, ns: string, kind?: string, name?: string): string => `k8s:${cluster}/${ns}${kind ? `/${kind}/${name}` : ''}`;
const record = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The host names a load balancer gave a service or an ingress (`status.loadBalancer.ingress[].hostname`). */
const lbHosts = (o: KubeObject): string[] =>
  list(record(record(o.status).loadBalancer).ingress).flatMap((i) => str(record(i).hostname) ?? []).map((h) => h.toLowerCase());

/** What a workload's settings name that another source may hold: AWS host names (`dns:`) and queue URLs (`url:`). */
export function namedEndpoints(value: string): string[] {
  const out = new Set<string>();
  for (const m of value.matchAll(/https:\/\/sqs\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/\d{12}\/[\w.-]+/g)) out.add(`url:${m[0]}`);
  for (const m of value.matchAll(/[a-z0-9][a-z0-9.-]*\.amazonaws\.com(?:\.cn)?/gi)) if (!/^sqs\./i.test(m[0])) out.add(`dns:${m[0].toLowerCase()}`);
  return [...out];
}

/** The nodes and links of one Kubernetes cluster. Its namespaces are in the cluster node; its objects in their namespace. */
export function kubeTopology(k: KubeAnswers): { nodes: TopologyNode[]; links: TopologyLink[] } {
  const c = k.cluster;
  const nodes: TopologyNode[] = [{ id: c, kind: 'cluster', name: k.name ?? c.split('/').pop() ?? c }];
  const links: TopologyLink[] = [];
  const link = (from: string, to: string, kind: LinkKind): void => { links.push({ from, to, kind }); };
  const add = (kind: NodeKind, o: KubeObject, path: string, attrs: Record<string, string> = {}, aliases: string[] = []): string => {
    const ns = o.metadata.namespace ?? 'default';
    const id = k8sId(c, ns, path, o.metadata.name);
    nodes.push({ id, kind, name: o.metadata.name, cluster: c, namespace: ns, ...(aliases.length ? { aliases } : {}), ...(Object.keys(attrs).length ? { attrs } : {}) });
    link(id, k8sId(c, ns), 'in');
    return id;
  };
  for (const n of k.namespaces ?? []) {
    nodes.push({ id: k8sId(c, n.metadata.name), kind: 'namespace', name: n.metadata.name, cluster: c, namespace: n.metadata.name });
    link(k8sId(c, n.metadata.name), c, 'in');
  }
  const podLabels = new Map<string, { ns: string; labels: Record<string, string> }>();
  for (const d of k.deployments ?? []) {
    const template = record(d.spec?.template);
    const pod = record(template.spec);
    const id = add('deployment', d, 'deployment', attrsOf({ replicas: typeof d.spec?.replicas === 'number' ? d.spec.replicas : undefined }));
    podLabels.set(id, { ns: d.metadata.namespace ?? 'default', labels: record(record(template.metadata).labels) as Record<string, string> });
    link(id, k8sId(c, d.metadata.namespace ?? 'default', 'serviceaccount', str(pod.serviceAccountName) ?? 'default'), 'runs-as');
    const values = list(pod.containers).flatMap((ct) => list(record(ct).env).flatMap((e) => str(record(e).value) ?? []));
    for (const ref of new Set(values.flatMap(namedEndpoints))) link(id, ref, 'uses');
  }
  for (const s of k.services ?? []) {
    const ns = s.metadata.namespace ?? 'default';
    const id = add('service', s, 'service', attrsOf({ type: str(s.spec?.type) }));
    for (const h of lbHosts(s)) link(`dns:${h}`, id, 'routes-to');
    const selector = Object.entries(record(s.spec?.selector));
    if (selector.length === 0) continue;
    for (const [d, p] of podLabels) if (p.ns === ns && selector.every(([key, v]) => p.labels[key] === v)) link(id, d, 'selects');
  }
  for (const i of k.ingresses ?? []) {
    const ns = i.metadata.namespace ?? 'default';
    const id = add('ingress', i, 'ingress', attrsOf({ class: str(i.spec?.ingressClassName) }));
    for (const h of lbHosts(i)) link(`dns:${h}`, id, 'routes-to');
    const backends = [record(i.spec?.defaultBackend), ...list(i.spec?.rules).flatMap((r) => list(record(record(r).http).paths).map((p) => record(record(p).backend)))];
    for (const name of new Set(backends.flatMap((b) => str(record(b.service).name) ?? []))) link(id, k8sId(c, ns, 'service', name), 'routes-to');
  }
  for (const sa of k.serviceAccounts ?? []) {
    const role = sa.metadata.annotations?.[IRSA_ANNOTATION];
    const id = add('service-account', sa, 'serviceaccount', role ? { role } : {});
    if (role) link(id, role, 'assumes');
  }
  return { nodes, links };
}
