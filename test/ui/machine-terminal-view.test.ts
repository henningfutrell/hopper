// @vitest-environment happy-dom
// Issue #1128 part 6: the machine's terminal on the Machines view, rendered inside the whole app against a fake of the
// daemon's HTTP surface. An admin opens a machine's terminal: the panes of the hopper's herdr session there are listed, a
// pane a job holds names its job; picking one shows its screen, read through the hopper; Type sends the text, a key button
// presses that key, each with the pane named. An operator gets no machine terminal.
//
// Feature: the machine's terminal
//   Scenario: an admin lists a machine's panes, opens one no job holds and types into it
//   Scenario: an operator gets no machine terminal
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const T = '2026-10-14T12:00:00.000Z';
const desk = { id: 'desk', label: 'desk', maxLanes: 2, online: true, executors: ['herdr-claude'], herdr: { session: 'hopper' }, lanes: [], usage: [] };
const PANES = [{ paneId: 'w1:p1', tabId: 'w1:t1', title: 'my shell', agentStatus: 'unknown' }, { paneId: 'w1:p2', tabId: 'w1:t2', agent: 'claude', agentStatus: 'working', jobId: 'r1' }];

let calls: { method: string; path: string; body?: unknown }[] = [];

function fakeDaemon(role: 'admin' | 'operator') {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [], ended: [], locked: [] }),
    '/api/machines': () => ({ machines: [desk] }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/ui/api/machines/desk/terminal/panes': () => ({ machineId: 'desk', panes: PANES }),
    '/ui/api/machines/desk/terminal/screen': () => ({ machineId: 'desk', paneId: 'w1:p1', sessionId: 's1', screen: '$ ls\nnotes.txt', at: T }),
    '/ui/api/machines/desk/terminal/input': () => ({ sessionId: 's1' }),
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    calls.push({ method: init.method ?? 'GET', path, ...(init.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role, realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
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

async function boot(role: 'admin' | 'operator' = 'admin') {
  calls = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#machines';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon(role));
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.body.textContent).toContain('desk'));
}

const button = (text: RegExp) => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the machine terminal on the Machines view (issue #1128)', () => {
  it('an admin lists the machine\'s panes, opens one and types into it', async () => {
    await boot();
    await vi.waitFor(() => expect(button(/^Terminal$/)).toBeDefined());
    expect(posts('/ui/api/machines/desk/terminal/panes')).toHaveLength(0);
    await act(async () => { button(/^Terminal$/)!.click(); });
    await vi.waitFor(() => expect(document.querySelector('[data-slot="machine-terminal"]')!.textContent).toContain('my shell'));
    expect(document.querySelector('[data-slot="machine-terminal"]')!.textContent).toContain('r1');

    await act(async () => { button(/my shell/)!.click(); });
    await vi.waitFor(() => expect(document.querySelector('[data-slot="pane-terminal-screen"]')!.textContent).toContain('notes.txt'));
    expect(posts('/ui/api/machines/desk/terminal/screen')[0]!.body).toEqual({ paneId: 'w1:p1' });

    const input = document.querySelector<HTMLInputElement>('[data-slot="machine-terminal"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'ls');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button(/^Type$/)!.click(); });
    await vi.waitFor(() => expect(posts('/ui/api/machines/desk/terminal/input')).toEqual([{ method: 'POST', path: '/ui/api/machines/desk/terminal/input', body: { paneId: 'w1:p1', text: 'ls' } }]));
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-slot="machine-terminal"] [data-key="enter"]')!.click(); });
    await vi.waitFor(() => expect(posts('/ui/api/machines/desk/terminal/input').at(-1)!.body).toEqual({ paneId: 'w1:p1', keys: ['enter'] }));
  });

  it('an operator gets no machine terminal', async () => {
    await boot('operator');
    expect(button(/^Terminal$/)).toBeUndefined();
    expect(document.querySelector('[data-slot="machine-terminal"]')).toBeNull();
  });
});
