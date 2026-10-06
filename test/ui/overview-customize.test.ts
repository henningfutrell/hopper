// @vitest-environment happy-dom
// Issue #73: the overview is customizable and configurable. A viewer shows or hides each overview
// panel, moves it, sets its width and its settings from Customize; the browser keeps that overview
// layout, and the next load shows it. Reset brings back the default. The overview renders inside
// the whole app against a fake of the daemon's HTTP surface and a fake SSE.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'jh_overview';
const DEFAULT_ORDER = ['kpis', 'timeline', 'attention', 'lanes', 'waiting', 'ended', 'throughput', 'usage', 'live'];

function fakeDaemon() {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', routerMode: 'active', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], waitingAnswer: [], ended: [] },
    '/api/machines': { machines: [] },
    '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json({ authenticated: true, user: { role: 'viewer', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    return path in routes ? json(routes[path]) : new Response('{"error":"not found"}', { status: 404 });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

/** Loads the app as a browser would, with `stored` already in its storage (or nothing). */
async function boot(stored?: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#overview';
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem(KEY, stored);
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-overview-panel]')).not.toBeNull());
}

async function reload() {
  const stored = localStorage.getItem(KEY) ?? undefined;
  await act(async () => root?.unmount());
  await boot(stored);
}

const shown = () => [...document.querySelectorAll<HTMLElement>('[data-overview-panel]')].map((e) => e.dataset.overviewPanel);
const panel = (id: string) => document.querySelector<HTMLElement>(`[data-overview-panel="${id}"]`);
const row = (id: string) => document.querySelector<HTMLElement>(`[data-customize-panel="${id}"]`)!;
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? 'null') as { panels: { id: string; shown: boolean; width: number }[]; settings: Record<string, unknown> } | null;

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy();
  await act(async () => { (el as HTMLElement).click(); });
}
const button = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll<HTMLElement>('button')].find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name);

/** Drags `from` onto `to` as a browser fires it: dragstart, dragenter and dragover on the target, drop, dragend. */
async function drag(from: Element | null, to: Element | null) {
  expect(from).toBeTruthy();
  expect(to).toBeTruthy();
  const fire = (el: Element, type: string) => el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  await act(async () => { fire(from!, 'dragstart'); });
  await act(async () => { fire(to!, 'dragenter'); fire(to!, 'dragover'); });
  await act(async () => { fire(to!, 'drop'); fire(from!, 'dragend'); });
}

async function openCustomize() {
  await click(button(document, 'Customize'));
  await vi.waitFor(() => expect(row('kpis')).toBeTruthy());
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Overview layout', () => {
  it('nothing stored: every overview panel, in the default order', async () => {
    await boot();
    expect(shown()).toEqual(DEFAULT_ORDER);
  });

  it('what the browser stored is what the overview shows: hidden panels gone, order and widths kept', async () => {
    const panels = DEFAULT_ORDER.map((id) => ({ id, shown: id !== 'live', width: id === 'kpis' ? 3 : 1 }));
    await boot(JSON.stringify({ panels: [panels[7], ...panels.filter((_, i) => i !== 7)], settings: {} }));
    expect(shown()).toEqual(['usage', ...DEFAULT_ORDER.filter((id) => id !== 'usage' && id !== 'live')]);
    expect(panel('timeline')!.className).not.toContain('col-span-2');
    expect(panel('kpis')!.className).toContain('col-span-3');
  });

  it('a stored layout that will not parse: the default overview, not an empty page', async () => {
    await boot('{"panels":');
    expect(shown()).toEqual(DEFAULT_ORDER);
  });

  it('Customize hides a panel, moves one and widens one; a reload keeps all three', async () => {
    await boot();
    await openCustomize();
    await click(row('ended').querySelector('[role="switch"]'));
    await click(button(row('usage'), 'Move up'));
    await click(button(row('waiting'), 'Full width'));
    expect(shown()).toEqual(['kpis', 'timeline', 'attention', 'lanes', 'waiting', 'usage', 'throughput', 'live']);
    expect(stored()?.panels.find((p) => p.id === 'ended')?.shown).toBe(false);

    await reload();
    expect(shown()).toEqual(['kpis', 'timeline', 'attention', 'lanes', 'waiting', 'usage', 'throughput', 'live']);
    expect(panel('waiting')!.className).toContain('col-span-3');
  });

  it('a panel setting set in Customize shapes the panel: the ended-per-hour chart over 6 hours', async () => {
    await boot();
    expect(panel('throughput')!.textContent).toContain('24 h');
    await openCustomize();
    await click(button(row('throughput'), '6 h'));
    expect(panel('throughput')!.textContent).toContain('6 h');
    expect(stored()?.settings.throughputHours).toBe(6);
  });

  it('the lane timeline window chosen on the panel is remembered', async () => {
    await boot(JSON.stringify({ panels: [], settings: { timelineWindow: '24h' } }));
    expect(panel('timeline')!.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe('24h');
  });

  it('Reset brings back the default layout and forgets the stored one', async () => {
    await boot(JSON.stringify({ panels: DEFAULT_ORDER.map((id) => ({ id, shown: id === 'kpis', width: 3 })), settings: {} }));
    expect(shown()).toEqual(['kpis']);
    await openCustomize();
    await click(button(document, 'Reset'));
    expect(shown()).toEqual(DEFAULT_ORDER);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

// Issue #86: the overview can be rearranged as seen fit — panels dragged on the Overview itself, or
// rows dragged in Customize, go where they are dropped.
describe('Rearranging the overview', () => {
  it('Arrange: a panel dragged onto another takes its place; a reload keeps the order', async () => {
    await boot();
    expect(panel('live')!.getAttribute('draggable')).not.toBe('true');
    await click(button(document, 'Arrange'));
    expect(panel('live')!.getAttribute('draggable')).toBe('true');
    await drag(panel('live'), panel('kpis'));
    await drag(panel('kpis'), panel('lanes'));
    const order = ['live', 'timeline', 'attention', 'lanes', 'kpis', 'waiting', 'ended', 'throughput', 'usage'];
    expect(shown()).toEqual(order);

    await click(button(document, 'Done'));
    expect(panel('live')!.getAttribute('draggable')).not.toBe('true');
    await reload();
    expect(shown()).toEqual(order);
  });

  it('Arrange without dragging: Move earlier and Move later step past hidden panels', async () => {
    await boot(JSON.stringify({ panels: DEFAULT_ORDER.map((id) => ({ id, shown: id !== 'ended', width: 1 })), settings: {} }));
    await click(button(document, 'Arrange'));
    await click(button(panel('throughput')!, 'Move earlier'));
    expect(shown()).toEqual(['kpis', 'timeline', 'attention', 'lanes', 'throughput', 'waiting', 'usage', 'live']);
    await click(button(panel('waiting')!, 'Move later'));
    expect(shown()).toEqual(['kpis', 'timeline', 'attention', 'lanes', 'throughput', 'usage', 'waiting', 'live']);
    expect(button(panel('kpis')!, 'Move earlier')!.hasAttribute('disabled')).toBe(true);
    expect(button(panel('live')!, 'Move later')!.hasAttribute('disabled')).toBe(true);
  });

  it('a panel dropped while not arranging stays where it is', async () => {
    await boot();
    await drag(panel('live'), panel('kpis'));
    expect(shown()).toEqual(DEFAULT_ORDER);
  });

  it('Customize: a row dragged onto another takes its place', async () => {
    await boot();
    await openCustomize();
    await drag(row('usage'), row('attention'));
    expect(shown()).toEqual(['kpis', 'timeline', 'usage', 'attention', 'lanes', 'waiting', 'ended', 'throughput', 'live']);
    expect(stored()?.panels.map((p) => p.id)).toEqual(['kpis', 'timeline', 'usage', 'attention', 'lanes', 'waiting', 'ended', 'throughput', 'live']);
  });
});
