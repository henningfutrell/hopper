// @vitest-environment happy-dom
// Issue #2354: graphs scale with their panel. The lane timeline with many lanes is capped, and its idle lanes collapse;
// its label column leaves the plot room on a narrow panel. The usage graph's height follows its panel's width, so it
// stays legible at 360px.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LaneSpan } from '../../ui/src/model/history.ts';
import type { GraphLine } from '../../ui/src/model/usage-history.ts';

let width = 800;
class SizedResizeObserver {
  private readonly fn: (entries: { contentRect: { width: number; height: number } }[]) => void;
  constructor(fn: (entries: { contentRect: { width: number; height: number } }[]) => void) { this.fn = fn; }
  observe(): void { this.fn([{ contentRect: { width, height: 200 } }]); }
  disconnect(): void {}
  unobserve(): void {}
}

let root: Root | undefined;
async function render(el: ReturnType<typeof createElement>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', SizedResizeObserver);
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(el); });
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  width = 800;
  vi.unstubAllGlobals();
});

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const HOUR = 3_600_000;
const lanes = Array.from({ length: 24 }, (_, i) => `desk/lane-${String(i + 1).padStart(2, '0')}`);
// Lanes 1-4 ran a job in the window; the other 20 are idle.
const spans: LaneSpan[] = lanes.slice(0, 4).map((laneId, i) => ({ laneId, jobId: `job-${i}`, start: NOW - 2 * HOUR, end: NOW - HOUR, outcome: 'finished' }));
const rowNames = () => [...document.querySelectorAll('[data-lane-row]')].map((r) => r.getAttribute('data-lane-row'));
const button = (text: RegExp) => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''))!;

async function timeline(laneNameOf = (id: string) => id) {
  const mod = '../../ui/src/charts/lane-timeline.tsx';
  const { LaneTimeline } = (await import(mod)) as typeof import('../../ui/src/charts/lane-timeline.tsx');
  await render(createElement(LaneTimeline, { spans, waits: [], now: NOW, windowMs: 6 * HOUR, lanes, nameOf: (id: string) => id, laneNameOf }));
}

describe('the lane timeline with 24 lanes', () => {
  it('is capped: it shows the lanes that ran first, and Show all draws every lane', async () => {
    await timeline();
    const shown = rowNames();
    expect(shown.length).toBeLessThan(24);
    expect(shown).toEqual(expect.arrayContaining(lanes.slice(0, 4)));
    const svg = document.querySelector('svg[aria-label="Lane activity timeline"]')!;
    expect(Number(svg.getAttribute('height'))).toBeLessThanOrEqual(400);
    await act(async () => { button(/^Show all 24 lanes$/).click(); });
    expect(rowNames()).toHaveLength(24);
  });

  it('collapses its idle lanes, and shows them again', async () => {
    await timeline();
    await act(async () => { button(/^Hide 20 idle lanes$/).click(); });
    expect(rowNames()).toEqual(lanes.slice(0, 4));
    await act(async () => { button(/^Show 20 idle lanes$/).click(); });
    expect(rowNames()).toContain(lanes[23]);
  });

  it('on a 360px panel, the label column leaves the plot at least two thirds of the width', async () => {
    width = 360;
    await timeline((id) => `a-machine-with-a-long-name · ${id}`);
    const plot = document.querySelector('svg[aria-label="Lane activity timeline"] rect.fill-muted\\/40')!;
    expect(Number(plot.getAttribute('width'))).toBeGreaterThanOrEqual(360 * 2 / 3 - 16);
  });
});

describe('the usage graph', () => {
  const line: GraphLine = {
    key: 'a', label: 'a', color: 'var(--chart-1)', dash: 'solid', shownByDefault: true,
    series: { account: 'a', informational: false, unit: '%', points: [{ at: new Date(NOW - HOUR).toISOString(), usedFrac: 0.4 }], gaps: [], resets: [] },
  };
  async function graph() {
    const mod = '../../ui/src/charts/usage-history.tsx';
    const { UsageGraph } = (await import(mod)) as typeof import('../../ui/src/charts/usage-history.tsx');
    await render(createElement(UsageGraph, { lines: [line], hidden: new Set<string>(), from: NOW - 24 * HOUR, to: NOW, stepMs: 900_000, maxMs: 90 * 24 * HOUR }));
    return document.querySelector('svg[aria-label^="Usage over time"]')!;
  }

  it('its height follows its panel: shorter on a 360px panel, taller on a wide one', async () => {
    width = 360;
    const narrow = Number((await graph()).getAttribute('height'));
    await act(async () => root?.unmount());
    width = 1200;
    const wide = Number((await graph()).getAttribute('height'));
    expect(narrow).toBeGreaterThanOrEqual(160);
    expect(narrow).toBeLessThan(240);
    expect(wide).toBeGreaterThan(240);
  });

  it('on a 360px panel, its time labels fit the plot side by side', async () => {
    width = 360;
    const svg = await graph();
    const labels = [...svg.querySelectorAll('text[text-anchor="middle"]')];
    expect(labels.length).toBeGreaterThan(1);
    expect(labels.length * 40).toBeLessThanOrEqual(360 - 34 - 16);
  });
});
