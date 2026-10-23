// @vitest-environment happy-dom
// Issue #1511: draining a machine on its Machines card, rendered inside the whole app against a fake of the daemon's HTTP
// surface. Drain asks first, then posts; a drained machine shows a badge, who drained it and the jobs still on it, and
// Undrain posts at once. Issue #2499: the drain names its reason and when it ends; Drain stays off until a reason is typed.
//
// Feature: draining a machine
//   Scenario: Drain asks first, then posts the drain
//   Scenario: a drained machine says so and offers Undrain
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const DESK = { id: 'desk', label: 'desk', maxLanes: 2, online: true, executors: ['herdr-claude'], usage: [] };
const BUSY = [{ id: 'desk/lane-1', machineId: 'desk', state: 'busy', jobId: 'j1', openedAt: '2026-10-16T11:00:00.000Z' }];
let MACHINES: unknown[] = [];

const button = (text: RegExp) => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;

let calls: { method: string; path: string; body?: unknown }[] = [];

function fakeDaemon() {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [], ended: [], locked: [] }),
    '/api/machines': () => ({ machines: MACHINES }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/api/credential-check': () => ({ strict: false }),
    '/ui/api/machines/drain': () => ({ machineId: 'desk', drained: true, jobs: 1 }),
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    calls.push({ method: init.method ?? 'GET', path, ...(init.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    return path in routes ? json(routes[path]!()) : new Response('{"error":"not found"}', { status: 404 });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot(machines: unknown[]) {
  MACHINES = machines;
  calls = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#machines';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(button(/^Drain$|^Undrain$/)).toBeDefined());
}

const type = (el: HTMLInputElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('draining a machine on its Machines card (issue #1511)', () => {
  it('Drain asks first, then posts the drain', async () => {
    await boot([{ ...DESK, lanes: BUSY }]);
    expect(document.querySelector('[data-slot="drained"]')).toBeNull();
    await act(async () => { button(/^Drain$/)!.click(); });
    const dialog = await vi.waitFor(() => { const d = document.querySelector<HTMLElement>('[role="alertdialog"]'); expect(d).not.toBeNull(); return d!; });
    expect(dialog.textContent).toContain('The jobs on it now run to their end.');
    expect(posts('/ui/api/machines/drain')).toEqual([]);
    const confirm = [...dialog.querySelectorAll('button')].find((b) => /^Drain$/.test(b.textContent ?? ''))!;
    expect(confirm.disabled).toBe(true);
    await type(dialog.querySelector<HTMLInputElement>('input[name="drain-reason"]')!, 'seat rebuild');
    await type(dialog.querySelector<HTMLInputElement>('input[name="drain-hours"]')!, '6');
    expect(confirm.disabled).toBe(false);
    await act(async () => { confirm.click(); });
    await vi.waitFor(() => expect(posts('/ui/api/machines/drain')).toEqual([expect.objectContaining({ body: { machineId: 'desk', drained: true, reason: 'seat rebuild', hours: 6 } })]));
  });

  it('a drained machine says so, by whom, and the jobs still on it; Undrain posts at once', async () => {
    await boot([{ ...DESK, lanes: BUSY, drained: { person: 'Pat', via: 'cli', at: new Date().toISOString(), reason: 'seat rebuild', until: new Date(Date.now() + 3 * 3_600_000).toISOString() } }]);
    const notice = document.querySelector<HTMLElement>('[data-slot="drained"]')!;
    expect(notice.textContent).toContain('Drained by Pat');
    expect(notice.textContent).toContain('seat rebuild');
    expect(notice.textContent).toMatch(/ends by itself in 2h 59m/);
    expect(notice.textContent).toContain('The 1 job still on it runs to its end.');
    expect(document.body.textContent).toContain('drained');
    await act(async () => { button(/^Undrain$/)!.click(); });
    await vi.waitFor(() => expect(posts('/ui/api/machines/drain')).toEqual([expect.objectContaining({ body: { machineId: 'desk', drained: false } })]));
  });
});
