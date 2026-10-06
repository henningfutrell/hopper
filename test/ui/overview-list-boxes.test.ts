// @vitest-environment happy-dom
// Issue #84: list boxes are bounded, so the overview layout stays even. Every list box on the
// overview (Attention, Lanes, Waiting, Ended, Live activity) holds its list in a body of one fixed
// height bound that scrolls past it, at every screen width; every overview panel fills its cell,
// so the boxes of one row line up. The overview renders inside the whole app against a fake of the
// daemon's HTTP surface and a fake SSE.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const LIST_BOXES = ['attention', 'lanes', 'waiting', 'ended', 'live'];
const OTHER_PANELS = ['timeline', 'throughput', 'usage'];

function fakeDaemon() {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
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

async function boot() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#overview';
  localStorage.clear();
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-overview-panel]')).not.toBeNull());
}

const panel = (id: string) => document.querySelector<HTMLElement>(`[data-overview-panel="${id}"]`)!;
const body = (id: string) => panel(id).querySelector<HTMLElement>('[data-slot="panel-body"]')!;
const classes = (el: Element) => el.className.split(/\s+/);

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Overview list boxes', () => {
  it('every list box scrolls its list inside one height bound, at every screen width', async () => {
    await boot();
    for (const id of LIST_BOXES) {
      expect(body(id).dataset.listBox, id).toBe('');
      expect(classes(body(id)), id).toEqual(expect.arrayContaining(['max-h-96', 'overflow-y-auto']));
      expect(body(id).className, id).not.toMatch(/(sm|md|lg|xl):max-h/);
    }
  });

  it('a chart panel is not a list box', async () => {
    await boot();
    for (const id of OTHER_PANELS) expect(body(id).dataset.listBox, id).toBeUndefined();
  });

  it('every overview panel fills its cell, so the boxes of one row line up', async () => {
    await boot();
    for (const id of [...LIST_BOXES, ...OTHER_PANELS]) {
      expect(classes(panel(id).firstElementChild!), id).toContain('h-full');
    }
  });
});
