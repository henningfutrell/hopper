// @vitest-environment happy-dom
// Topology → Globe (ui/src/views/topology-globe.tsx, issue #1893): the globe beside the graph, on the same graph
// and the same filters; its regions with their counts, a click on a region lists its nodes and a click on a node shows the
// same details as the graph; the nodes with no known place in a list of their own; and the graph, saying why, when the
// browser has no WebGL or the scene cannot start. The three.js scene (globe-scene.ts) needs WebGL, which happy-dom has
// not: it is replaced here by a fake that records what it was asked to draw.
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobeArc, GlobeRegion } from '../../ui/src/model/topology-globe.ts';
import { EAST_DB, twoRegions } from '../support/topology-globe-graph.ts';

type Drawn = { regions: readonly GlobeRegion[]; arcs: readonly GlobeArc[]; selected?: string; onPick: (r: string) => void };
const scene = vi.hoisted(() => ({ drawn: [] as Drawn[], fail: undefined as string | undefined, disposed: 0 }));
vi.mock('../../ui/src/views/globe-scene.ts', () => ({
  mountGlobe: (_host: HTMLElement, regions: readonly GlobeRegion[], arcs: readonly GlobeArc[], selected: string | undefined, onPick: (r: string) => void) => {
    if (scene.fail) throw new Error(scene.fail);
    scene.drawn.push({ regions, arcs, selected, onPick });
    return { dispose: () => { scene.disposed += 1; } };
  },
}));

let root: Root | undefined;
beforeEach(() => { scene.drawn = []; scene.fail = undefined; scene.disposed = 0; });
afterEach(() => { act(() => root?.unmount()); root = undefined; document.body.innerHTML = ''; vi.restoreAllMocks(); });

const view = '../../ui/src/views/topology.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
type Graph = ReturnType<typeof twoRegions>;
const render = async (g: Graph): Promise<HTMLElement> => {
  type Props = { g: Graph; timeline: []; selected?: string; onSelect: (id: string) => void };
  const { TopologyPanel } = (await import(view)) as { TopologyPanel: (p: Props) => ReturnType<typeof createElement> };
  function Host() {
    const [selected, setSelected] = useState<string | undefined>();
    return createElement(TopologyPanel, { g, timeline: [], selected, onSelect: setSelected });
  }
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(Host)));
  return host;
};
const withWebgl = (): void => { vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((k: string) => (k === 'webgl2' ? {} : null)) as never); };
const button = (el: HTMLElement, text: string): HTMLButtonElement => [...el.querySelectorAll('button')].find((b) => b.textContent === text)!;
const click = (b: Element): void => { act(() => { (b as HTMLElement).click(); }); };
/** Lets the scene's chunk load (a dynamic import) and its effect run. */
const settle = async (): Promise<void> => { await act(async () => { await vi.dynamicImportSettled(); await new Promise((r) => setTimeout(r, 0)); }); };
const select = (el: HTMLElement, label: string, value: string): void => {
  const s = el.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  act(() => { s.value = value; s.dispatchEvent(new Event('change', { bubbles: true })); });
};
const regionLines = (el: HTMLElement): string[] => [...el.querySelectorAll('[data-slot="topology-globe-regions"] li')].map((li) => li.textContent ?? '');

describe('the Topology globe', () => {
  it('draws the regions and the arcs between them; lists each region with its counts and the nodes with no known place', async () => {
    withWebgl();
    const el = await render(twoRegions());
    click(button(el, 'Globe'));
    await settle();
    expect(el.querySelector('[data-slot="topology-graph"]')).toBeNull();
    expect(el.querySelector('[data-slot="topology-globe"]')).not.toBeNull();
    const drawn = scene.drawn.at(-1)!;
    expect(drawn.regions.map((r) => r.region)).toEqual(['eu-west-1', 'us-east-1']);
    expect(drawn.arcs).toEqual([{ from: 'eu-west-1', to: 'us-east-1', links: 1 }]);
    const [eu, us] = regionLines(el);
    expect(eu).toMatch(/^eu-west-1 \(Ireland\): \d+ nodes — /);
    expect(us).toBe('us-east-1 (N. Virginia): 2 nodes — 1 bucket, 1 database');
    const unplaced = el.querySelector('[data-slot="topology-globe-unplaced"]')!.textContent;
    expect(unplaced).toContain('bucket old-files — no region');
    expect(unplaced).toContain('bucket moon-files — region eu-moon-9 has no known place');
  });

  it('a click on a region lists its nodes; a click on a node shows the same details as the graph', async () => {
    withWebgl();
    const el = await render(twoRegions());
    click(button(el, 'Globe'));
    await settle();
    act(() => { scene.drawn.at(-1)!.onPick('us-east-1'); });
    await settle();
    const region = el.querySelector('[data-slot="topology-globe-region"]')!;
    expect(region.textContent).toContain('us-east-1 (N. Virginia): 2 nodes');
    expect(scene.drawn.at(-1)!.selected).toBe('us-east-1');
    click(button(region as HTMLElement, 'database reports'));
    const details = el.querySelector('[data-slot="topology-node"]')!;
    expect(details.textContent).toContain(EAST_DB);
    expect(details.textContent).toContain('is used by deployment orders');
    click(button(el, 'eu-west-1 (Ireland)'));
    expect(el.querySelector('[data-slot="topology-globe-region"]')!.textContent).toContain('eu-west-1 (Ireland)');
  });

  it('shares the filters with the graph', async () => {
    withWebgl();
    const el = await render(twoRegions());
    select(el, 'Kind', 'bucket');
    click(button(el, 'Globe'));
    await settle();
    expect(regionLines(el)).toEqual(['us-east-1 (N. Virginia): 1 node — 1 bucket']);
    expect(scene.drawn.at(-1)!.regions.map((r) => r.region)).toEqual(['us-east-1']);
    select(el, 'Kind', 'database');
    await settle();
    expect(regionLines(el)).toEqual(['eu-west-1 (Ireland): 1 node — 1 database', 'us-east-1 (N. Virginia): 1 node — 1 database']);
    click(button(el, 'Graph'));
    expect(el.querySelector<HTMLSelectElement>('select[aria-label="Kind"]')!.value).toBe('database');
    expect(el.querySelectorAll('[data-slot="topology-graph"] circle')).toHaveLength(2);
    expect(scene.disposed).toBeGreaterThan(0);
  });

  it('shows the graph and says why when the browser has no WebGL', async () => {
    const el = await render(twoRegions());
    click(button(el, 'Globe'));
    await settle();
    expect(el.querySelector('[data-slot="topology-globe-fallback"]')!.textContent).toContain('this browser has no WebGL');
    expect(el.querySelector('[data-slot="topology-graph"]')).not.toBeNull();
    expect(el.querySelector('[data-slot="topology-globe"]')).toBeNull();
    expect(scene.drawn).toEqual([]);
  });

  it('shows the graph and says why when the scene cannot start', async () => {
    withWebgl();
    scene.fail = 'Error creating WebGL context.';
    const el = await render(twoRegions());
    click(button(el, 'Globe'));
    await settle();
    expect(el.querySelector('[data-slot="topology-globe-fallback"]')!.textContent).toContain('Error creating WebGL context.');
    expect(el.querySelector('[data-slot="topology-graph"]')).not.toBeNull();
  });
});
