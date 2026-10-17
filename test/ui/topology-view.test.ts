// @vitest-environment happy-dom
// Infra → Topology (ui/src/views/topology.tsx, issue #1781): the panel draws the graph, a click on a node shows its
// details and its neighbours, a stale source says why, and an empty topology says how a check fills it.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { afterReport, joinGraph } from '../../src/domain/topology.ts';
import { awsTopology, kubeTopology } from '../../src/domain/topology-discover.ts';
import { aws, CLUSTER, kube } from '../support/topology-answers.ts';

let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; });

const AT = '2026-10-17T10:00:00.000Z';
const view = '../../ui/src/views/topology.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
const render = async (g: ReturnType<typeof joinGraph>): Promise<HTMLElement> => {
  const { TopologyPanel } = (await import(view)) as { TopologyPanel: (p: { g: typeof g; changes: [] }) => ReturnType<typeof createElement> };
  const el = document.createElement('div');
  document.body.append(el);
  root = createRoot(el);
  act(() => root!.render(createElement(TopologyPanel, { g, changes: [] })));
  return el;
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

  it('says how a check fills an empty topology', async () => {
    expect((await render({ nodes: [], links: [], sources: [] })).textContent).toContain('POST /ui/api/topology/report');
  });
});
