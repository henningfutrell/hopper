// @vitest-environment happy-dom
// Issue #201: the Queue view rendered in happy-dom inside the whole app against a fake of the daemon's
// HTTP surface. The Queue nav entry carries a badge while jobs wait on the pre-sort, and the Queue view
// names the queue sorter and links to where it is set up (#settings/routing).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const job = (id: string, accepted: boolean) => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status: 'queued', approved: false, accepted,
  createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z', attempts: 0,
});

function fakeDaemon(waiting: ReturnType<typeof job>[]) {
  const unaccepted = waiting.filter((j) => !j.accepted).map((j) => j.id);
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': {
      waiting, running: [], waitingAnswer: [], ended: [],
      gate: { mode: 'review', autoAcceptPerHour: null }, presort: { sorter: 'oldest-first', jobIds: unaccepted, reject: [] },
    },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot(waiting: ReturnType<typeof job>[]) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#queue';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon(waiting));
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
}

const queueLink = () => document.querySelector('aside nav a[href="#queue"]')!;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Queue badge', () => {
  it('the Queue nav entry counts the jobs waiting on the pre-sort', async () => {
    await boot([job('a1', true), job('n1', false), job('n2', false)]);
    await vi.waitFor(() => expect(queueLink().querySelector('[data-slot="nav-badge"]')?.textContent).toBe('2'));
    expect(queueLink().querySelector('[data-slot="nav-badge"]')!.getAttribute('title')).toBe('2 jobs wait on the pre-sort');
  });

  it('no badge when every waiting job is accepted', async () => {
    await boot([job('a1', true)]);
    await vi.waitFor(() => expect(document.body.textContent).toContain('goal a1'));
    expect(queueLink().querySelector('[data-slot="nav-badge"]')).toBeNull();
  });
});

describe('Where the sorter is set up', () => {
  it('the Queue view names the queue sorter and links to the routing settings', async () => {
    await boot([job('n1', false)]);
    const link = await vi.waitFor(() => { const a = document.querySelector('a[data-slot="queue-sorter-link"]'); expect(a).not.toBeNull(); return a!; });
    expect(link.getAttribute('href')).toBe('#settings/routing');
    expect(link.textContent).toContain('Set up the sorter');
    expect(document.querySelector('[data-slot="queue-sorter"]')!.textContent).toContain('oldest-first');
  });
});
