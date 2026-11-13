// @vitest-environment happy-dom
// Issue #2932: an account that prints no usage limits (an Enterprise plan) capped its machine at the soft lanes, and its usage
// source's `noLimits` option was only in Settings → Plugins. The Usage page shows it on the source's panel: an admin turns it
// on or off there, one plugins edit of that source's options.
//
// Feature: a usage source with no limits, on the Usage page
//   Scenario: an admin sees the source's No usage limits and turns it on: one options edit, the other options kept
//   Scenario: on, it turns off: the option leaves the options
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SOURCE = { name: 'claude-usage', problem: 'claude printed no usage limits' };
let options: Record<string, unknown> = {};
let calls: { method: string; path: string; body?: unknown }[] = [];

const plugins = () => ({
  roles: [], config: { source: 'stored', version: 'v1', warnings: [] },
  instances: [{ role: 'usage-source', instance: { name: 'claude-usage', plugin: 'claude-plan', options } }],
  plugins: [{ id: 'claude-plan', role: 'usage-source', options: { type: 'object', properties: { bin: { type: 'string' }, noLimits: { type: 'boolean', description: 'the account has no usage limits' } } } }],
  router: { instance: { name: 'r', plugin: 'pass-through' }, selection: {}, detection: {}, active: 'r', fallback: false },
  queueSorter: {}, escalationLevels: [], lists: {},
});

function fakeDaemon() {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [], ended: [], locked: [] }),
    '/api/machines': () => ({ machines: [] }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [SOURCE], limits: { soft: 0.7, hard: 0.95, softLanes: 1, defaults: { soft: 0.7, hard: 0.95, softLanes: 1 }, set: false }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/api/credential-check': () => ({ strict: false }), '/api/plugins': plugins,
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const body = init.body ? JSON.parse(String(init.body)) as { options?: Record<string, unknown> } : undefined;
    calls.push({ method: init.method ?? 'GET', path, ...(body ? { body } : {}) });
    if (init.method === 'POST' && path === '/ui/api/plugins') { options = body!.options!; return json(plugins()); }
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

async function boot(now: Record<string, unknown>) {
  calls = [];
  options = now;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#usage';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-slot="usage-no-limits"]')).not.toBeNull());
}

const box = (): HTMLInputElement => document.querySelector<HTMLInputElement>('[data-slot="usage-no-limits"] input[type="checkbox"]')!;
const posts = () => calls.filter((c) => c.method === 'POST' && c.path === '/ui/api/plugins');

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('a usage source with no limits, on the Usage page (issue #2932)', () => {
  it('an admin turns No usage limits on: one options edit, the other options kept', async () => {
    await boot({ bin: 'claude' });
    expect(document.querySelector('[data-slot="usage-no-limits"]')!.textContent).toMatch(/No usage limits/);
    expect(box().checked).toBe(false);
    await act(async () => { box().click(); });
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ action: 'options', role: 'usage-source', name: 'claude-usage', version: 'v1', options: { bin: 'claude', noLimits: true } });
    await vi.waitFor(() => expect(box().checked).toBe(true));
  });

  it('on, it turns off: the option leaves the options', async () => {
    await boot({ bin: 'claude', noLimits: true });
    expect(box().checked).toBe(true);
    await act(async () => { box().click(); });
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toMatchObject({ options: { bin: 'claude' } });
    expect((posts()[0]!.body as { options: object }).options).not.toHaveProperty('noLimits');
  });
});
