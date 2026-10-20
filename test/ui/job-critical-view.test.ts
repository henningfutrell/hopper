// @vitest-environment happy-dom
// Issue #2203, part 2: the critical flag on the job view (#job/<id>), rendered inside the whole app against a fake of the
// daemon's HTTP surface. The view says whether the job is a critical job, and why; an operator marks it critical, or
// clears the flag (POST /ui/api/jobs/:id/critical).
//
// Feature: the critical flag on the job view
//   Scenario: an operator marks a job of priority 50 critical
//   Scenario: a flagged job says so, and an operator clears the flag
//   Scenario: a job at the critical priority says so
//   Scenario: a viewer reads it and gets no button; an ended job offers no Mark critical
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/domain/types.ts';

const T = '2026-10-20T12:00:00.000Z';
const plain = {
  id: 'r1', spec: { executor: 'herdr-claude', payload: {}, goal: 'Reboot the nodes' }, priority: 50, status: 'running', approved: true, attempts: 1,
  createdAt: T, updatedAt: T, startedAt: T, laneId: 'desk/lane-1',
} as unknown as Job;
const flagged = { ...plain, id: 'f1', critical: true } as unknown as Job;
const urgent = { ...plain, id: 'p1', priority: 100 } as unknown as Job;
const ended = { ...plain, id: 'e1', status: 'finished', finishedAt: T, laneId: undefined } as unknown as Job;

let calls: { method: string; path: string; body?: unknown }[] = [];

function fakeDaemon(role: 'operator' | 'viewer') {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [plain, flagged, urgent], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [], ended: [ended], locked: [], criticalPriority: 100 }),
    '/api/machines': () => ({ machines: [] }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/ui/api/jobs/r1/critical': () => ({ ...plain, critical: true }),
    '/ui/api/jobs/f1/critical': () => ({ ...flagged, critical: undefined }),
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
  await vi.waitFor(() => expect(document.querySelector('[data-slot="job-critical"]')).not.toBeNull());
}

const button = (text: RegExp) => [...document.querySelectorAll('[data-slot="job-view"] button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const critical = () => document.querySelector<HTMLElement>('[data-slot="job-critical"]')!;
const posts = () => calls.filter((c) => c.method === 'POST' && c.path.startsWith('/ui/api/jobs/'));

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the critical flag on the job view (issue #2203)', () => {
  it('a job of priority 50 is not critical; Mark critical posts the flag', async () => {
    await boot('r1');
    expect(critical().dataset.critical).toBe('false');
    expect(critical().textContent).toBe('no');
    expect(button(/Clear critical flag/)).toBeUndefined();
    await act(async () => { button(/Mark critical/)!.click(); });
    await vi.waitFor(() => expect(posts()).toEqual([{ method: 'POST', path: '/ui/api/jobs/r1/critical', body: { critical: true } }]));
  });

  it('a flagged job says a person marked it; Clear critical flag posts', async () => {
    await boot('f1');
    expect(critical().dataset.critical).toBe('true');
    expect(critical().textContent).toBe('yes: a person marked it critical');
    expect(button(/Mark critical/)).toBeUndefined();
    await act(async () => { button(/Clear critical flag/)!.click(); });
    await vi.waitFor(() => expect(posts()).toEqual([{ method: 'POST', path: '/ui/api/jobs/f1/critical', body: { critical: false } }]));
  });

  it('a job at the critical priority says so', async () => {
    await boot('p1');
    expect(critical().dataset.critical).toBe('true');
    expect(critical().textContent).toBe('yes: its priority is at or above 100');
  });

  it('a viewer reads it and gets no button; an ended job offers no Mark critical', async () => {
    await boot('f1', 'viewer');
    expect(critical().dataset.critical).toBe('true');
    expect(button(/Clear critical flag/)).toBeUndefined();
    act(() => root?.unmount());
    await boot('e1');
    expect(button(/Mark critical/)).toBeUndefined();
  });
});
