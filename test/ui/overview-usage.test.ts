// @vitest-environment happy-dom
// Issue #85: with more than one usage source (an account each), the overview's Usage panel showed
// every account's readings at once, mixed. It shows one account: a tab per usage source picks it,
// and the browser keeps the choice in the overview layout. One usage source: no tabs.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'jh_overview';
const AT = new Date().toISOString();
const reading = (source: string, window: string, used: number) => ({ source, window, used, limit: 100, unit: '%', at: AT });
const account = (email: string) => ({ service: 'claude', identity: email, detail: {} });
const TWO = {
  readings: [reading('work', 'session', 11), reading('work', 'week', 12), reading('personal', 'session', 71), reading('personal', 'week', 72)],
  sources: [{ name: 'work', refreshedAt: AT, account: account('work@example.com') }, { name: 'personal', refreshedAt: AT, account: account('me@example.com') }],
  limits: { soft: 0.7, hard: 0.95 }, machines: [],
};
const ONE = { ...TWO, readings: TWO.readings.filter((r) => r.source === 'work'), sources: TWO.sources.slice(0, 1) };

function fakeDaemon(usage: unknown) {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', routerMode: 'active', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], waitingAnswer: [], ended: [] },
    '/api/machines': { machines: [] },
    '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: [] },
    '/api/usage': usage, '/api/accounts': { accounts: [] },
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

async function boot(usage: unknown, stored?: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#overview';
  localStorage.clear();
  if (stored !== undefined) localStorage.setItem(KEY, stored);
  vi.stubGlobal('fetch', fakeDaemon(usage));
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(usagePanel().textContent).toContain('session'));
}

const usagePanel = () => document.querySelector<HTMLElement>('[data-overview-panel="usage"]')!;
const gauges = () => usagePanel().textContent ?? '';
const tabs = () => [...usagePanel().querySelectorAll<HTMLElement>('[role="tab"]')];
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? 'null') as { settings: Record<string, unknown> } | null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Overview Usage panel with more than one account', () => {
  it('shows the first account only, with a tab per usage source', async () => {
    await boot(TWO);
    expect(tabs().map((t) => t.textContent)).toEqual(['work', 'personal']);
    expect(gauges()).toContain('11/100');
    expect(gauges()).toContain('work@example.com');
    expect(gauges()).not.toContain('71/100');
    expect(gauges()).not.toContain('me@example.com');
  });

  it('a tab shows that account instead, and the browser keeps the choice', async () => {
    await boot(TWO);
    const personal = tabs().find((t) => t.textContent === 'personal')!;
    await act(async () => {
      personal.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      personal.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      personal.click();
    });
    await vi.waitFor(() => expect(gauges()).toContain('71/100'));
    expect(gauges()).not.toContain('11/100');
    expect(stored()?.settings.usageSource).toBe('personal');
  });

  it('a stored choice is shown on load', async () => {
    await boot(TWO, JSON.stringify({ panels: [], settings: { usageSource: 'personal' } }));
    expect(gauges()).toContain('72/100');
    expect(gauges()).not.toContain('12/100');
  });

  it('one usage source: its readings, no tabs', async () => {
    await boot(ONE);
    expect(tabs()).toEqual([]);
    expect(gauges()).toContain('11/100');
  });
});
