// @vitest-environment happy-dom
// Topology (ui/src/views/topology.tsx, issue #1781): the panel draws the graph, a click on a node shows its
// details, its neighbours and the Infra changes that touched it, a stale source says why, and an empty topology says how a
// check fills it. The Applies and drift feed (ui/src/views/infra-timeline.tsx) links each entry to the nodes it touched.
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { afterReport, joinGraph } from '../../src/domain/topology.ts';
import { awsTopology, kubeTopology } from '../../src/domain/topology-discover.ts';
import type { TimelineEntry } from '../../ui/src/model/infra-plans.ts';
import { aws, CLUSTER, kube } from '../support/topology-answers.ts';

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; });

const AT = '2026-10-17T10:00:00.000Z';
const view = '../../ui/src/views/topology.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
const feed = '../../ui/src/views/infra-timeline.tsx';
const mount = (el: ReturnType<typeof createElement>): HTMLElement => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
};
type Graph = ReturnType<typeof joinGraph>;
const render = async (g: Graph, timeline: TimelineEntry[] = []): Promise<HTMLElement> => {
  type Props = { g: Graph; timeline: TimelineEntry[]; selected?: string; onSelect: (id: string) => void };
  const { TopologyPanel } = (await import(view)) as { TopologyPanel: (p: Props) => ReturnType<typeof createElement> };
  function Host() {
    const [selected, setSelected] = useState<string | undefined>();
    return createElement(TopologyPanel, { g, timeline, selected, onSelect: setSelected });
  }
  return mount(createElement(Host));
};
const good = (): Graph => joinGraph([
  afterReport(undefined, { source: { kind: 'aws', account: '111111111111', region: 'eu-west-1' }, ok: true, ...awsTopology(aws) }, 'collector', AT),
  afterReport(undefined, { source: { kind: 'kubernetes', cluster: CLUSTER }, ok: true, ...kubeTopology(kube) }, 'collector', AT),
]);
const clickNode = (el: HTMLElement, title: string): void => {
  const g = [...el.querySelectorAll('[data-slot="topology-graph"] g')].find((x) => x.querySelector('title')?.textContent === title)!;
  act(() => { g.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

describe('the Topology panel', () => {
  it('draws the graph; a click on a node shows its details and neighbours; a stale source says why', async () => {
    const kubeGood = afterReport(undefined, { source: { kind: 'kubernetes', cluster: CLUSTER }, ok: true, ...kubeTopology(kube) }, 'collector', AT);
    const el = await render(joinGraph([
      afterReport(undefined, { source: { kind: 'aws', account: '111111111111', region: 'eu-west-1' }, ok: true, ...awsTopology(aws) }, 'collector', AT),
      afterReport(kubeGood, { source: { kind: 'kubernetes', cluster: CLUSTER }, ok: false, error: 'the API server did not answer' }, 'collector', '2026-10-17T11:00:00.000Z'),
    ]));
    const svg = el.querySelector('[data-slot="topology-graph"]')!;
    expect(svg.querySelectorAll('circle').length).toBeGreaterThan(10);
    expect(el.textContent).toContain('failed: the API server did not answer');
    expect(el.textContent).toContain('One source is stale');
    const db = [...svg.querySelectorAll('g')].find((g) => g.querySelector('title')?.textContent === 'database orders')!;
    act(() => { db.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const details = el.querySelector('[data-slot="topology-node"]')!;
    expect(details.textContent).toContain('arn:aws:rds:eu-west-1:111111111111:db:orders');
    expect(details.textContent).toContain('is used by deployment orders');
    expect(details.textContent).toContain('engine');
  });

  it('lists the Infra changes that touched a node, newest first, and says when none did', async () => {
    const timeline: TimelineEntry[] = [
      { at: '2026-10-17T09:30:00.000Z', kind: 'apply', words: 'Applied plan 11111111 on cluster prod', subject: { asset: { kind: 'cluster', name: 'prod' } } },
      { at: '2026-10-17T09:00:00.000Z', kind: 'plan', words: 'Plan 11111111 recorded for cluster prod', subject: { asset: { kind: 'cluster', name: 'prod' } } },
    ];
    const el = await render(good(), timeline);
    clickNode(el, 'cluster prod');
    const changes = [...el.querySelectorAll('[data-slot="topology-node-changes"] li')].map((li) => li.textContent);
    expect(changes).toEqual([expect.stringContaining('Applied plan 11111111'), expect.stringContaining('Plan 11111111 recorded')]);
    expect(changes[0]).toContain('Apply');
    clickNode(el, 'database orders');
    expect(el.querySelector('[data-slot="topology-node"]')!.textContent).toContain('No infra change touched this node.');
  });

  it('says how a check fills an empty topology', async () => {
    expect((await render({ nodes: [], links: [], sources: [] })).textContent).toContain('POST /ui/api/topology/report');
  });
});

describe('the Applies and drift feed', () => {
  it('links each entry to the topology nodes it touched; a click picks the node', async () => {
    type Props = { timeline: TimelineEntry[]; g?: Graph; onNode: (id: string) => void };
    const { InfraTimeline } = (await import(feed)) as { InfraTimeline: (p: Props) => ReturnType<typeof createElement> };
    const timeline: TimelineEntry[] = [
      { at: '2026-10-17T09:30:00.000Z', kind: 'drift', words: 'Terraform drift on prod-vpc', subject: { target: 'prod-vpc' } },
      { at: '2026-10-17T09:00:00.000Z', kind: 'plan', words: 'Plan for a workspace', subject: { asset: { kind: 'terraform-workspace', name: 'utility' } } },
    ];
    const picked: string[] = [];
    const el = mount(createElement(InfraTimeline, { timeline, g: good(), onNode: (id) => picked.push(id) }));
    const [drift, plan] = [...el.querySelectorAll('[data-slot="infra-timeline"] > li')];
    const link = drift!.querySelector('button')!;
    expect(link.textContent).toBe('vpc prod-vpc');
    act(() => { link.click(); });
    expect(picked).toEqual(['arn:aws:ec2:eu-west-1:111111111111:vpc/vpc-1']);
    expect(plan!.querySelector('button')).toBeNull();
    const none = mount(createElement(InfraTimeline, { timeline, onNode: () => {} }));
    expect(none.querySelectorAll('button')).toHaveLength(0);
    expect(none.textContent).toContain('Terraform drift on prod-vpc');
  });

  it('says so when nothing happened', async () => {
    const { InfraTimeline } = (await import(feed)) as { InfraTimeline: (p: { timeline: TimelineEntry[]; onNode: () => void }) => ReturnType<typeof createElement> };
    expect(mount(createElement(InfraTimeline, { timeline: [], onNode: () => {} })).textContent).toContain('Nothing yet.');
  });
});
