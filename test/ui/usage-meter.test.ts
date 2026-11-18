// @vitest-environment happy-dom
// Issue #2966 (was #2932): the meter of a usage source's account — auto, live or analytics — is on the source's panel on the
// Usage page: an admin picks it there, one plugins edit of that source's options. The panel says which meter the source
// resolved to.
//
// Feature: the meter of a usage source, on the Usage page
//   Scenario: an admin sees the resolved meter and picks analytics: one options edit, the other options kept
//   Scenario: back to auto: the option leaves the options
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SOURCE = { name: 'claude-usage', problem: 'claude printed no usage limits', meter: 'live' };
let options: Record<string, unknown> = {};
let calls: { method: string; path: string; body?: unknown }[] = [];

const plugins = () => ({
  roles: [], config: { source: 'stored', version: 'v1', warnings: [] },
  instances: [{ role: 'usage-source', instance: { name: 'claude-usage', plugin: 'claude-plan', options } }],
  plugins: [{ id: 'claude-plan', role: 'usage-source', options: { type: 'object', properties: { bin: { type: 'string' }, meter: { type: 'string', enum: ['auto', 'live', 'analytics'], default: 'auto' } } } }],
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
  await vi.waitFor(() => expect(document.querySelector('[data-slot="usage-meter"]')).not.toBeNull());
}

const select = (): HTMLSelectElement => document.querySelector<HTMLSelectElement>('[data-slot="usage-meter"] select')!;
const pick = async (value: string) => {
  await act(async () => {
    select().value = value;
    select().dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const posts = () => calls.filter((c) => c.method === 'POST' && c.path === '/ui/api/plugins');

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the meter of a usage source, on the Usage page (issue #2966)', () => {
  it('an admin sees the resolved meter and picks analytics: one options edit, the other options kept', async () => {
    await boot({ bin: 'claude' });
    expect(document.querySelector('[data-slot="usage-meter"]')!.textContent).toMatch(/Meter/);
    expect(document.querySelector('[data-meter="claude-usage"]')!.textContent).toBe('meter: live');
    expect(select().value).toBe('auto');
    await pick('analytics');
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ action: 'options', role: 'usage-source', name: 'claude-usage', version: 'v1', options: { bin: 'claude', meter: 'analytics' } });
    await vi.waitFor(() => expect(select().value).toBe('analytics'));
  });

  it('back to auto: the option leaves the options', async () => {
    await boot({ bin: 'claude', meter: 'live' });
    expect(select().value).toBe('live');
    await pick('auto');
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toMatchObject({ options: { bin: 'claude' } });
    expect((posts()[0]!.body as { options: object }).options).not.toHaveProperty('meter');
  });
});
