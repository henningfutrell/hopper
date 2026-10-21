// @vitest-environment happy-dom
// Issue #2272: the sandbox host on a Machines card, rendered inside the whole app against a fake of the daemon's HTTP
// surface. A machine with no coding lanes offers Use as sandbox host, which adds it last; a machine of the sandbox host
// shows a badge, its place and how many sandboxes run there now, and Stop as sandbox host takes it out. A machine with
// coding lanes is never offered.
//
// Feature: the sandbox host on Machines
//   Scenario: Use as sandbox host adds a machine with no coding lanes, last
//   Scenario: a machine of the sandbox host says so, with its live sandbox count, and can be taken out
//   Scenario: a machine with coding lanes is not offered
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const DESK = { id: 'desk', label: 'desk', maxLanes: 2, online: true, executors: ['herdr-claude'], usage: [], lanes: [] };
const VM = { id: 'vm', label: 'vm', maxLanes: 0, online: true, executors: [], usage: [], lanes: [] };
let MACHINES: unknown[] = [];
let HOSTS: string[] | undefined;
const RUN = (id: string, machine: string, ended?: string) => ({ id, jobId: 'j1', template: 't', box: `hopper-need-t-${id}`, machine, startedAt: '2026-10-21T11:00:00.000Z', ...(ended ? { endedAt: ended } : {}) });
const RUNS = [RUN('a', 'vm'), RUN('b', 'vm'), RUN('c', 'vm', '2026-10-21T11:01:00.000Z'), RUN('d', 'local')];

const button = (text: RegExp) => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;

let calls: { method: string; path: string; body?: unknown }[] = [];

function fakeDaemon() {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [], ended: [], locked: [] }),
    '/api/machines': () => ({ machines: MACHINES, ...(HOSTS ? { sandboxHost: HOSTS } : {}) }), '/api/sandboxes': () => ({ runs: RUNS, problems: [] }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/api/credential-check': () => ({ strict: false }),
    '/ui/api/machines/sandbox-host': () => ({ hosts: [] }),
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

async function boot(machines: unknown[], hosts?: string[]) {
  MACHINES = machines;
  HOSTS = hosts;
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
  await vi.waitFor(() => expect(button(/^Drain$/)).toBeDefined());
}

const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the sandbox host on Machines (issue #2272)', () => {
  it('Use as sandbox host adds a machine with no coding lanes, last', async () => {
    await boot([DESK, VM], ['local']);
    expect(document.querySelector('[data-slot="sandbox-host"]')).toBeNull();
    await act(async () => { button(/^Use as sandbox host$/)!.click(); });
    await vi.waitFor(() => expect(posts('/ui/api/machines/sandbox-host')).toEqual([expect.objectContaining({ body: { hosts: ['local', 'vm'] } })]));
  });

  it('a machine of the sandbox host says so, with its live sandbox count, and can be taken out', async () => {
    await boot([DESK, { ...VM, sandboxHost: 1 }], ['vm', 'local']);
    const notice = await vi.waitFor(() => { const n = document.querySelector<HTMLElement>('[data-slot="sandbox-host"]'); expect(n?.textContent).toContain('2 sandboxes run here now.'); return n!; });
    expect(notice.textContent).toContain('The sandbox host: sandboxes start only here.');
    expect(document.body.textContent).toContain('sandbox host');
    await act(async () => { button(/^Stop as sandbox host$/)!.click(); });
    await vi.waitFor(() => expect(posts('/ui/api/machines/sandbox-host')).toEqual([expect.objectContaining({ body: { hosts: ['local'] } })]));
  });

  it('a machine with coding lanes is not offered', async () => {
    await boot([DESK]);
    expect(button(/sandbox host/)).toBeUndefined();
  });
});
