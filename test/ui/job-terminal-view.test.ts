// @vitest-environment happy-dom
// Issue #1128 part 4: the job's terminal on the job view (#job/<id>), rendered inside the whole app against a fake of the
// daemon's HTTP surface. An operator opens a running job's terminal: its pane's screen shows, read through the hopper;
// Type sends the text, a key button presses that key. A viewer, or a job that holds no pane, gets no terminal.
//
// Feature: the job's terminal
//   Scenario: an operator opens a running job's terminal and types into it
//   Scenario: a viewer, or an ended job, gets no terminal
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/domain/types.ts';

const T = '2026-10-14T12:00:00.000Z';
const running = {
  id: 'r1', spec: { executor: 'herdr-claude', payload: {}, goal: 'Reach the service' }, priority: 50, status: 'running', approved: true, attempts: 1,
  createdAt: T, updatedAt: T, startedAt: T, laneId: 'desk/lane-1',
} as unknown as Job;
const ended = { ...running, id: 'e1', status: 'finished', finishedAt: T, laneId: undefined } as unknown as Job;

let calls: { method: string; path: string; body?: unknown }[] = [];

function fakeDaemon(role: 'operator' | 'viewer') {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [running], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [], ended: [ended], locked: [] }),
    '/api/machines': () => ({ machines: [] }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/ui/api/jobs/r1/terminal/screen': () => ({ jobId: 'r1', sessionId: 's1', screen: '● Checking port 8443\n> ', at: T }),
    '/ui/api/jobs/r1/terminal/input': () => ({ sessionId: 's1' }),
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

async function boot(id: string, role: 'operator' | 'viewer' = 'operator') {
  calls = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = `#job/${id}`;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon(role));
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-slot="job-view"], [data-slot="job-timeline"]')).not.toBeNull());
}

const button = (text: RegExp) => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the job terminal on the job view (issue #1128)', () => {
  it('an operator opens it: the pane\'s screen shows; Type sends the text, a key button presses its key', async () => {
    await boot('r1');
    await vi.waitFor(() => expect(button(/Open terminal/)).toBeDefined());
    expect(posts('/ui/api/jobs/r1/terminal/screen')).toHaveLength(0);
    await act(async () => { button(/Open terminal/)!.click(); });
    await vi.waitFor(() => expect(document.querySelector('[data-slot="job-terminal-screen"]')!.textContent).toContain('● Checking port 8443'));
    expect(posts('/ui/api/jobs/r1/terminal/screen').length).toBeGreaterThan(0);

    const input = document.querySelector<HTMLInputElement>('[data-slot="job-terminal"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'yes');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button(/^Type$/)!.click(); });
    await vi.waitFor(() => expect(posts('/ui/api/jobs/r1/terminal/input')).toEqual([{ method: 'POST', path: '/ui/api/jobs/r1/terminal/input', body: { text: 'yes' } }]));
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-key="enter"]')!.click(); });
    await vi.waitFor(() => expect(posts('/ui/api/jobs/r1/terminal/input').at(-1)!.body).toEqual({ keys: ['enter'] }));
  });

  it('a viewer, or a job that holds no pane, gets no terminal', async () => {
    await boot('r1', 'viewer');
    expect(document.querySelector('[data-slot="job-terminal"]')).toBeNull();
    act(() => root?.unmount());
    await boot('e1');
    expect(document.querySelector('[data-slot="job-terminal"]')).toBeNull();
  });
});
