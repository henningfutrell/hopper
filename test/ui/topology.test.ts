// The infrastructure topology in the UI (ui/src/model/topology.ts, issue #1781), pure: the filters and the graph they
// leave, a node's neighbours in words, the Infra changes entries that touched a node and the nodes each one touched, each
// source's state, and a layout that puts every node inside the drawing.
import { describe, expect, it } from 'vitest';
import { afterReport, joinGraph } from '../../src/domain/topology.ts';
import { awsTopology, kubeTopology } from '../../src/domain/topology-discover.ts';
import type { TimelineEntry } from '../../ui/src/model/infra-plans.ts';
import { entryNodes, filterChoices, filterGraph, layout, neighbours, nodeEntries, sourceName, sourceState } from '../../ui/src/model/topology.ts';
import { aws, CLUSTER, kube } from '../support/topology-answers.ts';

const AT = '2026-10-17T10:00:00.000Z';
const graph = () => joinGraph([
  afterReport(undefined, { source: { kind: 'aws', account: '111111111111', region: 'eu-west-1' }, ok: true, ...awsTopology(aws) }, 'collector', AT),
  afterReport(undefined, { source: { kind: 'kubernetes', cluster: CLUSTER }, ok: true, ...kubeTopology(kube) }, 'collector', AT),
]);
const DB = 'arn:aws:rds:eu-west-1:111111111111:db:orders';

describe('the topology model', () => {
  it('offers the filters the nodes hold, and keeps only the links whose two ends a filter keeps', () => {
    const g = graph();
    const c = filterChoices(g);
    expect(c.accounts).toEqual(['111111111111', '222222222222', '333333333333']);
    expect(c.clusters).toEqual([{ id: CLUSTER, name: 'prod' }]);
    expect(c.regions).toEqual(['eu-west-1']);
    const inCluster = filterGraph(g, { cluster: CLUSTER });
    expect(inCluster.nodes.every((n) => n.id === CLUSTER || n.cluster === CLUSTER)).toBe(true);
    expect(inCluster.nodes.some((n) => n.kind === 'database')).toBe(false);
    const ids = new Set(inCluster.nodes.map((n) => n.id));
    expect(inCluster.links.every((l) => ids.has(l.from) && ids.has(l.to))).toBe(true);
    expect(filterGraph(g, { kind: 'database' }).nodes.map((n) => n.id)).toEqual([DB]);
  });

  it('says how each neighbour is linked, from the node\'s side', () => {
    const near = neighbours(graph(), DB).map((x) => `${x.words} ${x.node.kind} ${x.node.name}`);
    expect(near).toEqual(expect.arrayContaining(['is in vpc prod-vpc', 'is used by deployment orders']));
  });

  it('links each Infra changes entry to the nodes it touched, and lists a node\'s changes, newest first', () => {
    const g = graph();
    const vpc = g.nodes.find((n) => n.kind === 'vpc')!;
    const entry = (words: string, minute: number, subject: TimelineEntry['subject']): TimelineEntry => ({ at: `2026-10-17T09:${String(minute).padStart(2, '0')}:00.000Z`, kind: 'plan', words, subject });
    const entries = [
      entry('vpc by name', 50, { target: 'prod-vpc' }),
      entry('apply as a role', 40, { asset: { kind: 'aws-role', name: '111111111111/deploy' } }),
      entry('cluster', 30, { asset: { kind: 'cluster', name: 'prod' } }),
      entry('namespace', 20, { asset: { kind: 'namespace', name: 'prod/shop' } }),
      entry('vpc by id', 10, { target: 'VPC-1' }),
      entry('workspace', 5, { asset: { kind: 'terraform-workspace', name: 'utility-network' } }),
      entry('another vpc', 1, { target: 'vpc-2' }),
    ];
    const [byName, role, cluster, namespace, byId, workspace, other] = entries.map((e) => entryNodes(g, e));
    expect(byName).toEqual([vpc.id]);
    expect(byId).toEqual([vpc.id]);
    expect(role!.sort()).toEqual(['arn:aws:iam::111111111111:role/deploy', 'aws-account:111111111111']);
    expect(cluster).toEqual([CLUSTER]);
    expect(namespace).toEqual([`k8s:${CLUSTER}/shop`]);
    expect([workspace, other]).toEqual([[], []]);
    expect(entryNodes(g, { at: '2026-10-17T09:00:00.000Z', kind: 'plan', words: 'none' })).toEqual([]);
    expect(nodeEntries(g, vpc.id, [...entries].reverse()).map((e) => e.words)).toEqual(['vpc by name', 'vpc by id']);
    expect(nodeEntries(g, 'aws-account:111111111111', entries).map((e) => e.words)).toEqual(['apply as a role']);
  });

  it('says what a source holds, and why a stale one is stale', () => {
    const [s] = graph().sources;
    expect(sourceName(s!)).toBe('AWS 111111111111 eu-west-1');
    expect(sourceState(s!)).toEqual({ stale: false, words: `${s!.lastGood!.nodes} nodes and ${s!.lastGood!.links} links, read at ${AT}, by collector` });
    const stale = sourceState({ ...s!, lastRead: { at: '2026-10-17T11:00:00.000Z', ok: false, error: 'AccessDenied' } });
    expect(stale.stale).toBe(true);
    expect(stale.words).toMatch(/^the last read at 2026-10-17T11:00:00.000Z failed: AccessDenied; shown: /);
    expect(sourceName({ ...s!, source: { kind: 'kubernetes', cluster: CLUSTER } })).toBe('Kubernetes prod');
  });

  it('places every node inside the drawing, the same way each time', () => {
    const g = graph();
    const a = layout(g.nodes, g.links, 640);
    expect(a).toHaveLength(g.nodes.length);
    expect(a.every((p) => p.x >= 0 && p.x <= 640 && p.y >= 0 && p.y <= 640)).toBe(true);
    expect(layout(g.nodes, g.links, 640)).toEqual(a);
  });
});
