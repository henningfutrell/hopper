// @vitest-environment happy-dom
// The Events view as a long page (issue #2353): with 500 events, 30 lines to a page with Back and More; a filter starts
// again at its first page; the header with the filter stays in view.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ev = (seq: number) => ({
  seq, schemaVersion: 1, id: `e${seq}`, type: seq % 2 ? 'job.started' : 'lane.opened', at: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)).toISOString(),
  data: {}, ...(seq % 2 ? { jobId: `job-${seq}` } : { laneId: 'm1:lane-1', machineId: 'm1' }),
});
const EVENTS = Array.from({ length: 500 }, (_, i) => ev(i + 1));

function fakeDaemon() {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: EVENTS },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    return path in routes ? json(200, routes[path]) : json(404, { error: 'not found' });
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
  window.location.hash = '#events';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(lines().length).toBeGreaterThan(0));
}

const lines = () => [...document.querySelectorAll<HTMLElement>('[data-event-seq]')];
const range = () => document.querySelector('[data-slot="pager-range"]')?.textContent;
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the Events view as a long page (issue #2353)', () => {
  it('shows 500 events 30 lines to a page, newest first', async () => {
    await boot();
    expect(lines()).toHaveLength(30);
    expect(lines()[0]!.dataset.eventSeq).toBe('500');
    expect(range()).toBe('1–30 of 500');
    await click(document.querySelector('[data-slot="pager-more"]')!);
    expect(range()).toBe('31–60 of 500');
    expect(lines()[0]!.dataset.eventSeq).toBe('470');
  });

  it('a filter starts again at its first page', async () => {
    await boot();
    await click(document.querySelector('[data-slot="pager-more"]')!);
    const input = document.querySelector<HTMLInputElement>('[data-slot="events-filter"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'lane.opened');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await vi.waitFor(() => expect(range()).toBe('1–30 of 250'));
    expect(lines().every((l) => l.textContent?.includes('lane.opened'))).toBe(true);
  });

  it('keeps the header with the filter in view', async () => {
    await boot();
    const header = document.querySelector('[data-slot="panel-header"][data-sticky]')!;
    expect(header.querySelector('[data-slot="events-filter"]')).not.toBeNull();
  });
});
