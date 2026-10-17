// @vitest-environment happy-dom
// Issue #655: a job's trust on the job view (#job/<id>), rendered inside the whole app against a fake of the daemon's HTTP
// surface. The job's trust level from its stamp; for an operator, Quarantine (after a confirm) or Lift quarantine.
//
// Feature: Quarantine on the job view
//   Scenario: an operator quarantines a running job, after a confirm
//   Scenario: an operator lifts a quarantine
//   Scenario: a viewer reads the level and gets no button; an ended job offers none
//   Scenario: a job Jev's trust check lowered says why; an operator approves its trust, after a confirm (part 4)
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/domain/types.ts';

const T = '2026-10-13T12:00:00.000Z';
const stamp = (level: string) => ({ v: 1, level, reasons: ['origin:trusted'], by: 'intake', at: T, mac: 'm' });
const running = {
  id: 'r1', spec: { executor: 'herdr-claude', payload: {}, goal: 'Reach the service' }, priority: 50, status: 'running', approved: true, attempts: 1,
  createdAt: T, updatedAt: T, startedAt: T, laneId: 'desk/lane-1', stamp: stamp('trusted'),
} as unknown as Job;
const quarantined = { ...running, id: 'q1', stamp: { ...stamp('quarantined'), was: 'trusted', by: 'person' } } as unknown as Job;
const ended = { ...running, id: 'e1', status: 'finished', finishedAt: T, laneId: undefined } as unknown as Job;
const lowered = {
  ...running, id: 'l1', status: 'held', laneId: undefined, startedAt: undefined,
  stamp: { ...stamp('untrusted'), reasons: ['origin:approved', 'jev:touches_ci'], by: 'jev', check: { pick: 'lower:untrusted:touches_ci', confidence: 0.9, applied: true } },
} as unknown as Job;

let calls: { method: string; path: string; body?: unknown }[] = [];

function fakeDaemon(role: 'operator' | 'viewer') {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [lowered], running: [running, quarantined], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [], ended: [ended], locked: [] }),
    '/api/machines': () => ({ machines: [] }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/ui/api/jobs/r1/quarantine': () => ({ ...running, stamp: { ...stamp('quarantined'), was: 'trusted' } }),
    '/ui/api/jobs/q1/unquarantine': () => ({ ...quarantined, stamp: stamp('trusted') }),
    '/ui/api/jobs/l1/approve-trust': () => ({ ...lowered, stamp: { ...stamp('approved'), by: 'person' } }),
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
  await vi.waitFor(() => expect(document.querySelector('[data-slot="job-trust"]')).not.toBeNull());
}

const button = (text: RegExp) => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const trust = () => document.querySelector<HTMLElement>('[data-slot="job-trust"]')!;
const dialog = () => vi.waitFor(() => { const d = document.querySelector('[role="alertdialog"]'); expect(d).not.toBeNull(); return d!; });

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('trust on the job view (issue #655)', () => {
  it('shows the level; Quarantine asks first, then posts', async () => {
    await boot('r1');
    expect(trust().dataset.level).toBe('trusted');
    expect(trust().textContent).toContain('trusted');
    expect(button(/Lift quarantine/)).toBeUndefined();
    await act(async () => { button(/^Quarantine$/)!.click(); });
    const d = await dialog();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await act(async () => { [...d.querySelectorAll('button')].find((b) => b.textContent === 'Quarantine')!.click(); });
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path.startsWith('/ui/api/jobs/'))).toEqual([{ method: 'POST', path: '/ui/api/jobs/r1/quarantine', body: {} }]));
  });

  it('a quarantined job says so, and Lift quarantine posts', async () => {
    await boot('q1');
    expect(trust().dataset.level).toBe('quarantined');
    expect(trust().textContent).toContain('reaches nothing through the hopper');
    expect(button(/^Quarantine$/)).toBeUndefined();
    await act(async () => { button(/Lift quarantine/)!.click(); });
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path.startsWith('/ui/api/jobs/'))).toEqual([{ method: 'POST', path: '/ui/api/jobs/q1/unquarantine', body: {} }]));
  });

  it('a viewer reads the level and gets no button; an ended job offers none', async () => {
    await boot('q1', 'viewer');
    expect(trust().dataset.level).toBe('quarantined');
    expect(button(/Lift quarantine/)).toBeUndefined();
    act(() => root?.unmount());
    await boot('e1');
    expect(button(/^Quarantine$/)).toBeUndefined();
  });

  it('a job Jev\'s trust check lowered says why; Approve trust asks first, then posts', async () => {
    await boot('l1');
    expect(trust().dataset.level).toBe('untrusted');
    expect(document.querySelector('[data-slot="job-trust-check"]')?.textContent).toBe('Jev\'s trust check lowered it: it changes CI, workflow files or branch rules');
    await act(async () => { button(/Approve trust/)!.click(); });
    const d = await dialog();
    expect(calls.some((c) => c.method === 'POST' && c.path.startsWith('/ui/api/jobs/'))).toBe(false);
    await act(async () => { [...d.querySelectorAll('button')].find((b) => b.textContent === 'Approve trust')!.click(); });
    await vi.waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.path.startsWith('/ui/api/jobs/'))).toEqual([{ method: 'POST', path: '/ui/api/jobs/l1/approve-trust', body: {} }]));
  });

  it('a job no check lowered offers no Approve trust', async () => {
    await boot('r1');
    expect(document.querySelector('[data-slot="job-trust-check"]')).toBeNull();
    expect(button(/Approve trust/)).toBeUndefined();
  });
});
