// @vitest-environment happy-dom
// Infra → Topology, Discover now (ui/src/views/topology.tsx, issue #1781 part 3): a person asks the hopper to read every
// account and cluster its vault mints for; the panel shows the graph after it, and says when the run goes on or failed.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterReport, joinGraph } from '../../src/domain/topology.ts';
import { awsTopology } from '../../src/domain/topology-discover.ts';
import { aws } from '../support/topology-answers.ts';

type Graph = ReturnType<typeof joinGraph>;
let root: Root | undefined;
let calls: { method: string; path: string; body?: string }[] = [];
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const EMPTY: Graph = { nodes: [], links: [], sources: [] };
const found = (): Graph => joinGraph([afterReport(undefined, { source: { kind: 'aws', account: '111111111111', region: 'eu-west-1' }, ok: true, ...awsTopology(aws) }, 'topology discovery', '2026-10-17T10:00:00.000Z')]);

async function render(answer: () => Response, onGraph: (g: Graph) => void): Promise<void> {
  await act(async () => root?.unmount());
  document.body.innerHTML = '';
  calls = [];
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    calls.push({ method: init.method ?? 'GET', path: String(path), ...(typeof init.body === 'string' ? { body: init.body } : {}) });
    return answer();
  }));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  type Props = { g: Graph; timeline: unknown[]; onSelect: (id: string) => void; onGraph: (g: Graph) => void };
  const view = '../../ui/src/views/topology.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { TopologyPanel } = (await import(view)) as { TopologyPanel: (p: Props) => ReturnType<typeof createElement> };
  const host = document.createElement('div');
  document.body.append(host);
  await act(async () => { root = createRoot(host); root.render(createElement(TopologyPanel, { g: EMPTY, timeline: [], onSelect: () => {}, onGraph })); });
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const click = async (): Promise<void> => {
  const button = [...document.querySelectorAll('[data-slot="topology-discover"] button')][0] as HTMLButtonElement;
  expect(button.textContent).toContain('Discover now');
  await act(async () => { button.click(); });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const status = (): string => document.querySelector('[data-slot="topology-discover"] [role="status"]')?.textContent ?? '';

describe('Discover now', () => {
  it('asks the hopper to read the topology, and shows the graph after it', async () => {
    const g = found();
    const onGraph = vi.fn();
    await render(() => json({ state: 'done', graph: g }), onGraph);
    expect(document.body.textContent).toContain('Set an aws-account minting credential on Settings → Vault, then Discover now');
    await click();
    expect(calls).toEqual([{ method: 'POST', path: '/ui/api/topology/discover', body: '{}' }]);
    expect(onGraph).toHaveBeenCalledWith(g);
    expect(status()).toBe('Discovery read every account and cluster the vault mints for.');
  });

  it('says when the run goes on in the background, and when it did not run', async () => {
    await render(() => json({ state: 'running', error: 'the runtime of user u1 is not loaded', graph: EMPTY }), () => {});
    await click();
    expect(status()).toBe('Discovery goes on in the background: the runtime of user u1 is not loaded.');
    await render(() => json({ error: 'topology discovery is not part of this hopper' }, 503), () => {});
    await click();
    expect(status()).toMatch(/^Discovery did not run: /);
  });
});
