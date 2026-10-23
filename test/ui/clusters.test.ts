// @vitest-environment happy-dom
// Settings → Clusters (issue #1766), rendered in happy-dom inside the whole app against a fake of the daemon's HTTP
// surface: a person adds a cluster override — an alias, an account, a region — and the whole list is saved with the
// version read; an edit keeps the cluster's name; an override is removed after a confirm.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const EXISTING = { name: 'utility-identity-edit', eksName: 'utility', writeRole: 'hopper-identity-edit' };

interface Call { path: string; method: string; body?: Record<string, unknown> }

function fakeDaemon() {
  const calls: Call[] = [];
  let view = { clusters: [EXISTING] as unknown[], version: 'v1' };
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/questions': { questions: [] },
    '/api/sources': { sources: [] }, '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method: init.method ?? 'GET', ...(body ? { body } : {}) });
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/api/clusters') return json(200, view);
    if (path === '/ui/api/clusters') { view = { clusters: body!.clusters as unknown[], version: 'v2' }; return json(200, view); }
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
  return { fetch, calls };
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;
const panel = () => document.querySelector('[data-slot="clusters"]');
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const click = (b: HTMLElement | undefined) => act(async () => { b!.click(); });
const type = (el: HTMLInputElement, text: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

async function boot() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#settings/clusters';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon();
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(panel()?.querySelector('[data-slot="cluster"]')).not.toBeNull());
  return daemon;
}

afterEach(() => { act(() => root?.unmount()); root = undefined; vi.unstubAllGlobals(); });

const saved = (d: ReturnType<typeof fakeDaemon>) => d.calls.find((c) => c.path === '/ui/api/clusters')?.body;
const field = (k: string) => panel()!.querySelector<HTMLInputElement>(`[data-slot="cluster-${k}"]`)!;

describe('Settings → Clusters (issue #1766)', () => {
  it('adds an override and saves the whole list, with the empty fields left out', async () => {
    const daemon = await boot();
    expect(panel()!.textContent).toContain('write: hopper-identity-edit');
    await click(button('Add a cluster override'));
    await type(field('name'), 'lab-view');
    await type(field('eksName'), 'utility');
    await type(field('account'), ' 111111111111 ');
    await type(field('region'), 'eu-west-1');
    await click(button('Save'));
    await vi.waitFor(() => expect(saved(daemon)).toEqual({
      version: 'v1', clusters: [EXISTING, { name: 'lab-view', eksName: 'utility', account: '111111111111', region: 'eu-west-1' }],
    }));
    await vi.waitFor(() => expect(panel()!.querySelectorAll('[data-slot="cluster"]')).toHaveLength(2));
  });

  it('edits an override: the name stays, a field cleared goes', async () => {
    const daemon = await boot();
    await click(button('Edit'));
    expect(field('name').disabled).toBe(true);
    await type(field('eksName'), '');
    await click(button('Save'));
    await vi.waitFor(() => expect(saved(daemon)).toEqual({ version: 'v1', clusters: [{ name: 'utility-identity-edit', writeRole: 'hopper-identity-edit' }] }));
  });

  it('removes an override after a confirm', async () => {
    const daemon = await boot();
    await click(button('Remove'));
    await click([...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent?.trim() === 'Remove') as HTMLElement);
    await vi.waitFor(() => expect(saved(daemon)).toEqual({ version: 'v1', clusters: [] }));
  });
});
