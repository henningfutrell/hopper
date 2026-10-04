// @vitest-environment happy-dom
// The Routing view (issue #18) opened straight from its link, rendered in happy-dom inside the whole
// app against a fake of the daemon's HTTP surface: it loads the plugins report itself (no other view
// has to have been opened first), lists every router and queue sorter, and a Use posts a select.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const empty = { type: 'object', properties: {} };
const PLUGINS = {
  roles: ['router', 'queue-sorter'],
  config: { path: '/home/user/.config/job-hopper/plugins.yaml', source: 'file', version: 'p1', warnings: [] },
  instances: [
    { role: 'router', instance: { name: 'pass-through', plugin: 'pass-through' } },
    { role: 'queue-sorter', instance: { name: 'priority', plugin: 'priority' } },
  ],
  router: { instance: { name: 'pass-through', plugin: 'pass-through' }, selection: 'detected', detection: { status: 'available' }, active: 'pass-through', fallback: false },
  queueSorter: { instance: { name: 'priority', plugin: 'priority' }, detection: { status: 'available' }, active: 'priority', fallback: false },
  answerer: { detection: { status: 'available' }, active: null, fallback: false },
  assessor: { instance: { name: 'fable', plugin: 'always-escalate' }, detection: { status: 'available' }, active: 'always-escalate', fallback: false },
  executors: { instances: [] }, jobSources: { instances: [] }, machines: { instances: [] }, usageSources: { instances: [] }, notifiers: { instances: [] },
  plugins: [
    { id: 'pass-through', role: 'router', describe: 'admits every job', builtin: true, detection: { status: 'available' }, options: empty },
    { id: 'jev-router', role: 'router', describe: 'Jev', builtin: true, detection: { status: 'unavailable', reason: 'no Jev checkout' }, options: empty },
    { id: 'priority', role: 'queue-sorter', describe: 'effective priority first', builtin: true, detection: { status: 'available' }, options: empty },
    { id: 'oldest-first', role: 'queue-sorter', describe: 'oldest first', builtin: true, detection: { status: 'available' }, options: empty },
  ],
  errors: [], warnings: [],
};
const ROUTING = { path: PLUGINS.config.path, version: 'p1', rules: [], targets: { machines: ['local'], executors: ['herdr-claude'] }, skipped: [] };

interface Call { path: string; method: string; body?: Record<string, unknown> }

function fakeDaemon() {
  const calls: Call[] = [];
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', routerMode: 'shadow', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], waitingAnswer: [], ended: [], counts: {} },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/plugins': PLUGINS, '/api/routing': ROUTING,
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method: init.method ?? 'GET', ...(body ? { body } : {}) });
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z' });
    if (path === '/ui/api/plugins') return json(200, PLUGINS);
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

async function boot() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#routing';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon();
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  return daemon;
}

const item = (id: string) => [...document.querySelectorAll('li')].find((l) => l.textContent?.includes(id) && l.querySelector('.font-mono')?.textContent === id);

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Routing view', () => {
  it('opened by its link, loads the plugins report and lists every router and queue sorter', async () => {
    await boot();
    await vi.waitFor(() => expect(item('oldest-first')).toBeDefined());
    const text = document.body.textContent!;
    for (const s of ['pass-through', 'jev-router', 'no Jev checkout', 'priority', 'oldest-first']) expect(text).toContain(s);
  });

  it('Use on a queue sorter posts a select against the report version', async () => {
    const daemon = await boot();
    await vi.waitFor(() => expect(item('oldest-first')).toBeDefined());
    const use = [...item('oldest-first')!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Use');
    await act(async () => { use!.click(); });
    await vi.waitFor(() => expect(daemon.calls.some((c) => c.path === '/ui/api/plugins')).toBe(true));
    expect(daemon.calls.find((c) => c.path === '/ui/api/plugins')!.body).toEqual({ action: 'select', role: 'queue-sorter', plugin: 'oldest-first', version: 'p1' });
  });
});
