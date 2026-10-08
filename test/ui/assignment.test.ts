// @vitest-environment happy-dom
// Issue #387 in the Overview: a waiting job can be rejected from its row, with an optional reason that goes
// in the request (and so the job's timeline), never anywhere else; a running job whose issue is no longer
// assigned to the user is flagged, and its row keeps the stop button. Renders the whole app against a fake of
// the daemon's HTTP surface and a fake SSE.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job, JobStatus } from '../../src/domain/types.ts';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const job = (id: string, status: JobStatus, o: Partial<Job> = {}): Job => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status, approved: false,
  createdAt: minutesAgo(30), updatedAt: minutesAgo(1), attempts: 1,
  source: { source: 'github', kind: 'github-account', key: `https://github.com/owner/repo/issues/${id}`, repo: 'owner/repo', number: 1, assignee: 'owner' }, ...o,
} as Job);

const jobs = [
  job('r1', 'running', { laneId: 'm1/lane-1', startedAt: minutesAgo(25), sourceState: { sync: { claimReported: true, unassignedAt: minutesAgo(2) } } }),
  job('r2', 'running', { laneId: 'm1/lane-2', startedAt: minutesAgo(5) }),
  job('w1', 'queued'),
];

const posts: { path: string; body: unknown }[] = [];

function fakeDaemon() {
  const of = (...s: JobStatus[]) => jobs.filter((j) => s.includes(j.status));
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: of('queued'), running: of('running'), operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [{ id: 'm1', label: 'm1', maxLanes: 2, online: true, executors: ['test'], usage: [], lanes: [
      { id: 'm1/lane-1', machineId: 'm1', state: 'busy', jobId: 'r1', openedAt: minutesAgo(25) },
      { id: 'm1/lane-2', machineId: 'm1', state: 'busy', jobId: 'r2', openedAt: minutesAgo(5) },
    ] }] },
    '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json({ authenticated: true, user: { role: 'operator', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) });
      return json({});
    }
    return path in routes ? json(routes[path]) : new Response('{"error":"not found"}', { status: 404 });
  });
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
  window.location.hash = '#overview';
  localStorage.clear();
  posts.length = 0;
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-job-group="waiting"][data-job-id="w1"]')).not.toBeNull());
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const button = (el: ParentNode, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
const setValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('assignment in the Overview (issue #387)', () => {
  it('a waiting job is rejected from its row, with the reason the user gives', async () => {
    await boot();
    const row = document.querySelector<HTMLElement>('[data-job-group="waiting"][data-job-id="w1"]')!;
    await act(async () => button(row, 'Reject')!.click());
    const input = await vi.waitFor(() => document.querySelector<HTMLInputElement>('[data-reject-reason]')!);
    await act(async () => setValue(input, '  not mine  '));
    await act(async () => button(document, 'Reject job')!.click());
    await vi.waitFor(() => expect(posts).toEqual([{ path: '/ui/api/jobs/w1/reject', body: { reason: 'not mine' } }]));
  });

  it('a running job no longer assigned to the user is flagged, with its stop button; another is not', async () => {
    await boot();
    const flagged = document.querySelector<HTMLElement>('[data-lane-job="r1"]')!;
    expect(flagged.querySelector('[data-unassigned]')?.textContent).toContain('No longer assigned to you');
    expect(flagged.querySelector('[aria-label="Cancel job"]')).not.toBeNull();
    expect(document.querySelector('[data-lane-job="r2"] [data-unassigned]')).toBeNull();
  });
});
