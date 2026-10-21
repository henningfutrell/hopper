// @vitest-environment happy-dom
// Issue #433: every timeline entry that is about a job links to its job view (#job/<id>). On the lane timeline, a
// running bar, a question wait and a failed bar; in Live activity and the Events view, every event with a job. An event
// with no job (a lane opened) has no link. The job view shows the job and its events, also for a job the store does not
// hold (read from /api/jobs/:id), and says so for a job the daemon does not know.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const NOW = Date.now();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const job = (id: string, status: string, o: Record<string, unknown> = {}) => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status, approved: true, accepted: true,
  createdAt: at(30), updatedAt: at(5), attempts: 1, ...o,
});

const ev = (seq: number, type: string, minutesAgo: number, o: Record<string, unknown> = {}) => ({
  seq, schemaVersion: 1, id: `e${seq}`, type, at: at(minutesAgo), data: {}, ...o,
});

const EVENTS = [
  ev(1, 'lane.opened', 20, { laneId: 'm1:lane-1', machineId: 'm1' }),
  ev(2, 'job.started', 15, { jobId: 'run1', laneId: 'm1:lane-1' }),
  ev(3, 'job.started', 14, { jobId: 'ask1', laneId: 'm1:lane-2' }),
  ev(4, 'question.asked', 10, { jobId: 'ask1', laneId: 'm1:lane-2', questionId: 'q1', data: { text: 'which?' } }),
  ev(5, 'job.started', 13, { jobId: 'fail1', laneId: 'm1:lane-3' }),
  ev(6, 'job.failed', 8, { jobId: 'fail1', laneId: 'm1:lane-3', data: { error: 'boom' } }),
];

function fakeDaemon() {
  const running = [job('run1', 'running', { laneId: 'm1:lane-1', startedAt: at(15) })];
  const waitingAnswer = [job('ask1', 'waiting_answer', { laneId: 'm1:lane-2' })];
  const ended = [job('fail1', 'failed', { error: 'boom', finishedAt: at(8) })];
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running, operatorLed: [], parked: [], waitingAnswer, ended, locked: [], gate: { mode: 'auto-accept', autoAcceptPerHour: null }, presort: null },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: EVENTS },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/jobs/old1': job('old1', 'finished', { finishedAt: at(60 * 48) }),
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

/** Every observed element is 800 wide: the lane timeline draws at a width. */
class SizedResizeObserver {
  private readonly fn: (entries: { contentRect: { width: number; height: number } }[]) => void;
  constructor(fn: (entries: { contentRect: { width: number; height: number } }[]) => void) { this.fn = fn; }
  observe(): void { this.fn([{ contentRect: { width: 800, height: 200 } }]); }
  disconnect(): void {}
  unobserve(): void {}
}

let root: Root | undefined;

async function boot(hash: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('ResizeObserver', SizedResizeObserver);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function go(hash: string) {
  await act(async () => { window.location.hash = hash; window.dispatchEvent(new HashChangeEvent('hashchange')); });
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const line = (seq: number) => document.querySelector(`[data-event-seq="${seq}"]`);

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Lane timeline links to the job', () => {
  it('a running bar, a question wait and a failed bar each link to their job', async () => {
    await boot('#dashboard');
    const timeline = () => document.querySelector('svg[aria-label="Lane activity timeline"]');
    await vi.waitFor(() => expect(timeline()).not.toBeNull());
    for (const id of ['run1', 'ask1', 'fail1']) expect(timeline()!.querySelector(`a[href="#job/${id}"] rect`), id).not.toBeNull();
    expect(timeline()!.querySelector(`a[href="#job/ask1"] rect[data-wait]`)).not.toBeNull();
  });
});

describe('Event lines link to the job', () => {
  it('in Live activity, an event with a job links to it; one with no job has no link', async () => {
    await boot('#dashboard');
    await vi.waitFor(() => expect(line(6)).not.toBeNull());
    expect(line(2)!.closest('a')?.getAttribute('href') ?? line(2)!.querySelector('a')?.getAttribute('href')).toBe('#job/run1');
    expect(line(4)!.querySelector('a')?.getAttribute('href')).toBe('#job/ask1');
    expect(line(6)!.querySelector('a')?.getAttribute('href')).toBe('#job/fail1');
    expect(line(1)!.querySelector('a')).toBeNull();
    expect(line(1)!.closest('a')).toBeNull();
  });

  it('in the Events view, the same', async () => {
    await boot('#events');
    await vi.waitFor(() => expect(line(6)).not.toBeNull());
    expect(line(4)!.querySelector('a')?.getAttribute('href')).toBe('#job/ask1');
    expect(line(1)!.querySelector('a')).toBeNull();
    // Issue #2375: the stream is a table of rows (it was a code block, issue #1169).
    expect(line(4)!.closest('[data-slot="events-table"]')).not.toBeNull();
  });
});

describe('The job view', () => {
  it('a click on a failed job event opens that job: its goal, its error and its events', async () => {
    await boot('#events');
    await vi.waitFor(() => expect(line(6)).not.toBeNull());
    const link = line(6)!.querySelector('a')!;
    await act(async () => { link.click(); });
    if (window.location.hash !== '#job/fail1') await go('#job/fail1');
    const view = () => document.querySelector('[data-slot="job-view"]');
    await vi.waitFor(() => expect(view()?.getAttribute('data-job-id')).toBe('fail1'));
    expect(view()!.textContent).toContain('goal fail1');
    expect(view()!.textContent).toContain('boom');
    expect(view()!.querySelector('[data-event-seq="5"]')).not.toBeNull();
    expect(view()!.querySelector('[data-event-seq="2"]')).toBeNull();
    expect(document.title).toBe('Job · hopper');
  });

  it('a job the store does not hold is read from the daemon', async () => {
    await boot('#job/old1');
    await vi.waitFor(() => expect(document.querySelector('[data-slot="job-view"]')?.textContent).toContain('goal old1'));
  });

  it('a job the daemon does not know is said so', async () => {
    await boot('#job/nope');
    await vi.waitFor(() => expect(document.querySelector('[data-slot="job-view"]')?.textContent).toContain('No job nope'));
  });
});
