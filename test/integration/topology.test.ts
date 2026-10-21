// Issue #1781, through the real composition root, the real HTTP server and the real database: the infrastructure topology
// (design.md "The infrastructure topology"). A read-only check reports what a test AWS account and a test Kubernetes
// cluster answered, with an API token; Infra reads one graph of both.
//
// Feature: the infrastructure topology joins AWS and Kubernetes into one graph
//   Scenario: a check reports an AWS account and a Kubernetes cluster; the graph holds both, and the links between them
//   Scenario: a cluster out of reach keeps its last good snapshot, says why, and the rest of the graph is read again
//   Scenario: a grant without the scope topology:report is refused; a report that is not whole is refused, with why
//   Scenario: Infra reads only the nodes its changes can touch (issue #2367), and they link the same nodes as the whole graph
import { afterEach, describe, expect, it } from 'vitest';
import { awsTopology, kubeTopology } from '../../src/domain/topology-discover.ts';
import type { TopologyGraph } from '../../src/domain/topology.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { aws, CLUSTER, DB_HOST, kube, ROLE } from '../support/topology-answers.ts';
import type { TimelineEntry } from '../../ui/src/model/infra-plans.ts';
import { entryNodes, topologyPathFor } from '../../ui/src/model/topology.ts';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<{ a: TestApp; session: string; mint: (scopes: string[]) => Promise<string> }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  t = await startTestApp({ dbPath: db.dbPath });
  const a = t;
  const session = await a.login();
  const mint = async (scopes: string[]): Promise<string> => {
    const r = await a.ui('/ui/api/api-tokens', { action: 'mint', label: 'topology collector', holder: 'ci', role: 'operator', scopes }, { token: session });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (r.body as { token: string }).token;
  };
  return { a, session, mint };
}

const send = async (a: TestApp, token: string, body: unknown) => {
  const res = await fetch(`${a.url}/ui/api/topology/report`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const graph = async (a: TestApp, session: string): Promise<TopologyGraph> =>
  (await a.api<TopologyGraph>('GET', '/api/topology', undefined, { 'x-hopper-session': session })).body;

const AWS_SOURCE = { kind: 'aws', account: '111111111111', region: 'eu-west-1' };
const KUBE_SOURCE = { kind: 'kubernetes', cluster: CLUSTER };

describe('the infrastructure topology', () => {
  it('joins what a check found in an AWS account and a Kubernetes cluster into one graph; a cluster out of reach keeps its last good snapshot', async () => {
    const { a, session, mint } = await boot();
    expect((await graph(a, session))).toEqual({ nodes: [], links: [], sources: [] });
    const token = await mint(['topology:report']);
    const first = await send(a, token, { sources: [{ source: AWS_SOURCE, ok: true, ...awsTopology(aws) }, { source: KUBE_SOURCE, ok: true, ...kubeTopology(kube) }] });
    expect(first.status, JSON.stringify(first.json)).toBe(200);

    const g = await graph(a, session);
    const kinds = new Set(g.nodes.map((n) => n.kind));
    for (const k of ['aws-account', 'vpc', 'cluster', 'load-balancer', 'database', 'queue', 'iam-role', 'namespace', 'deployment', 'service', 'ingress', 'service-account']) expect(kinds).toContain(k);
    expect(g.nodes.filter((n) => n.id === CLUSTER)).toHaveLength(1);
    const sa = `k8s:${CLUSTER}/shop/serviceaccount/orders`;
    expect(g.links).toContainEqual({ from: sa, to: ROLE, kind: 'assumes' });
    expect(g.links).toContainEqual({ from: `k8s:${CLUSTER}/shop`, to: CLUSTER, kind: 'in' });
    expect(g.links).toContainEqual({ from: aws.loadBalancers![0]!.LoadBalancerArn, to: `k8s:${CLUSTER}/shop/service/orders`, kind: 'routes-to' });
    expect(g.sources.map((s) => [s.key, s.reporter, s.lastRead.ok])).toEqual([['aws/111111111111/eu-west-1', 'topology collector', true], [`kubernetes/${CLUSTER}`, 'topology collector', true]]);
    const before = g.sources[1]!.lastGood!;

    // The cluster does not answer; the account does. Nothing of the cluster is lost.
    const second = await send(a, token, { sources: [{ source: AWS_SOURCE, ok: true, ...awsTopology(aws) }, { source: KUBE_SOURCE, ok: false, error: 'the API server did not answer' }] });
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    const after = await graph(a, session);
    expect(after.nodes.map((n) => n.id)).toEqual(g.nodes.map((n) => n.id));
    expect(after.links).toContainEqual({ from: sa, to: ROLE, kind: 'assumes' });
    expect(after.sources[1]).toMatchObject({ lastGood: before, lastRead: { ok: false, error: 'the API server did not answer' } });

    const events = (await a.events()).filter((e) => e.type === 'infra.topology_reported');
    expect(events).toHaveLength(2);
    expect(events[1]).not.toHaveProperty('jobId');
    expect(events[1]!.data).toEqual({
      reporter: 'topology collector',
      sources: [{ key: 'aws/111111111111/eu-west-1', ok: true, nodes: g.sources[0]!.lastGood!.nodes, links: g.sources[0]!.lastGood!.links }, { key: `kubernetes/${CLUSTER}`, ok: false, error: 'the API server did not answer' }],
    });
  });

  // Issue #2367: the whole graph was 2 MB on each Infra visit, read only to name the nodes of its timeline.
  it('Infra reads only the nodes its changes can touch, and they link the same nodes as the whole graph', async () => {
    const { a, session, mint } = await boot();
    const token = await mint(['topology:report']);
    expect((await send(a, token, { sources: [{ source: AWS_SOURCE, ok: true, ...awsTopology(aws) }, { source: KUBE_SOURCE, ok: true, ...kubeTopology(kube) }] })).status).toBe(200);
    const whole = await graph(a, session);
    const entry = (subject: TimelineEntry['subject']): TimelineEntry => ({ at: '2026-10-21T00:00:00Z', kind: 'plan', words: 'a change', ...(subject ? { subject } : {}) });
    const timeline = [
      entry({ target: DB_HOST }), entry({ target: ROLE.toUpperCase() }), entry({ asset: { kind: 'aws-account', name: '111111111111' } }),
      entry({ asset: { kind: 'aws-role', name: '222222222222/orders-irsa' } }), entry({ asset: { kind: 'cluster', name: 'prod' } }),
      entry({ asset: { kind: 'namespace', name: 'prod/shop' } }), entry({ asset: { kind: 'argocd-app', name: 'shop' } }), entry(undefined),
    ];
    const path = topologyPathFor(timeline)!;
    expect(path).toMatch(/^\/api\/topology\?touching=/);
    const touched = (await a.api<TopologyGraph>('GET', path, undefined, { 'x-hopper-session': session })).body;
    expect(touched.nodes.length).toBeLessThan(whole.nodes.length);
    expect(touched.links).toEqual([]);
    for (const e of timeline) expect(entryNodes(touched, e), JSON.stringify(e.subject)).toEqual(entryNodes(whole, e));
    expect(timeline.slice(0, 6).every((e) => entryNodes(whole, e).length > 0)).toBe(true);
    // No changes: nothing to read.
    expect(topologyPathFor([])).toBeUndefined();
  });

  it('refuses a grant without the scope, a report that is not whole, and a source named twice', async () => {
    const { a, session, mint } = await boot();
    const outOfScope = await send(a, await mint(['topology:read']), { sources: [{ source: AWS_SOURCE, ok: false, error: 'AccessDenied' }] });
    expect(outOfScope.status).toBe(403);
    expect(String(outOfScope.json.error)).toMatch(/do not cover topology:report/);
    const token = await mint(['topology:report']);
    const bad = await send(a, token, { sources: [{ source: AWS_SOURCE, ok: true, nodes: [{ id: 'x', kind: 'lambda', name: 'x' }], links: [] }] });
    expect(bad.status).toBe(400);
    expect(String(bad.json.error)).toMatch(/source 1: node x: kind must be one of/);
    const twice = await send(a, token, { sources: [{ source: AWS_SOURCE, ok: false, error: 'a' }, { source: AWS_SOURCE, ok: false, error: 'b' }] });
    expect(twice.status).toBe(400);
    expect(String(twice.json.error)).toMatch(/twice/);
    expect((await send(a, token, { sources: [] })).status).toBe(400);
    expect((await graph(a, session)).sources).toEqual([]);
  });
});
