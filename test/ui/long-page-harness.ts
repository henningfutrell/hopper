// The long pages' test harness (issue #2353, part 2): the whole app booted in happy-dom on one hash, over a fake of the
// daemon's routes the page reads, and its unmount. `keep` boots again with the page choices left in browser storage, as a
// reload does. Test support only.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';

const BASE: Record<string, unknown> = {
  '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
  '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
  '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
  '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/sources': { sources: [] },
  '/api/questions': { questions: [] }, '/api/accounts': { accounts: [] },
  '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95, softLanes: 1, defaults: { soft: 0.7, hard: 0.95, softLanes: 1 } }, machines: [] },
};

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

/** Boots the app on `hash`, the routes over the base ones; a route not named answers 404. */
export async function boot(hash: string, routes: Record<string, unknown> = {}, keep = false) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = hash;
  if (!keep) localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const all = { ...BASE, ...routes };
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    return path in all ? json(200, all[path]) : json(404, { error: 'not found' });
  }));
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await settle();
}

export async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

export async function unmount() {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
}

export const click = async (el: Element | null | undefined) => { await act(async () => { el!.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); };
export const all = (sel: string) => [...document.querySelectorAll(sel)];
/** The fold toggle of the panel whose title is `title`. */
export const toggleOf = (title: string) => all('[data-slot="panel-toggle"]').find((b) => b.textContent?.includes(title));
/** Whether the panel whose title is `title` is open: its `data-open`. */
export const openOf = (title: string) => toggleOf(title)?.closest('[data-open]')?.getAttribute('data-open');
