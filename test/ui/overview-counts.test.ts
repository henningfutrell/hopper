// @vitest-environment happy-dom
// Issue #45: the overview's cards and its lists read one job store, so each card's number is the
// number of rows in the list it names — on load, and again after the stream reports a change. The
// overview renders inside the whole app against a fake of the daemon's HTTP surface and a fake SSE.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job, JobStatus } from '../../src/domain/types.ts';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const job = (id: string, status: JobStatus, o: Partial<Job> = {}): Job => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status, approved: false,
  createdAt: hoursAgo(2), updatedAt: hoursAgo(1), attempts: 1, ...o,
} as Job);

/** What /api/queue answers: the daemon's partition of the jobs it holds. */
function queueOf(jobs: Job[]) {
  const of = (...s: JobStatus[]) => jobs.filter((j) => s.includes(j.status));
  return { waiting: of('queued', 'held'), running: of('claimed', 'running'), waitingAnswer: of('waiting_answer'), ended: of('finished', 'failed', 'cancelled') };
}

function fakeDaemon(initial: Job[]) {
  let jobs = initial;
  const routes = (): Record<string, unknown> => ({
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': queueOf(jobs),
    '/api/machines': { machines: [{ id: 'm1', label: 'm1', maxLanes: 2, online: true, executors: ['test'], usage: [],
      lanes: [{ id: 'm1/lane-1', machineId: 'm1', state: 'busy', jobId: 'r1', openedAt: hoursAgo(1) }] }] },
    '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
  });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetch = vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json({ authenticated: true, user: { role: 'viewer', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    const r = routes();
    return path in r ? json(r[path]) : new Response('{"error":"not found"}', { status: 404 });
  });
  return { fetch, setJobs: (next: Job[]) => { jobs = next; } };
}

const streams: FakeEventSource[] = [];
class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (m: { data: string }) => void>();
  constructor() { streams.push(this); }
  addEventListener(type: string, fn: (m: { data: string }) => void): void { this.listeners.set(type, fn); }
  close(): void {}
}

let root: Root | undefined;

async function boot(jobs: Job[]) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#overview';
  localStorage.clear();
  const daemon = fakeDaemon(jobs);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-kpi="waiting"]')).not.toBeNull());
  return daemon;
}

const card = (kpi: string) => Number(document.querySelector(`[data-kpi="${kpi}"] [data-slot="kpi-value"]`)?.textContent?.split('/')[0]);
const rows = (group: string, status?: string) =>
  new Set([...document.querySelectorAll<HTMLElement>(`[data-job-group="${group}"]`)].filter((r) => !status || r.dataset.status === status).map((r) => r.dataset.jobId)).size;

/** Every card that names a list, and the rows of that list. */
function cardsAndLists() {
  return {
    running: [card('running'), rows('running')], waiting: [card('waiting'), rows('waiting')],
    waitingAnswer: [card('waitingAnswer'), rows('waitingAnswer')],
    finished: [card('finished'), rows('ended', 'finished')], failed: [card('failed'), rows('ended', 'failed')],
  };
}
const agree = (m: Record<string, number[]>) => Object.fromEntries(Object.entries(m).map(([k, [c, l]]) => [k, c === l]));

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  streams.length = 0;
  vi.unstubAllGlobals();
});

describe('Overview cards and lists', () => {
  it('one job on a question and none queued: the Waiting card and the Waiting list both say 0, On a question both say 1', async () => {
    await boot([job('q1', 'waiting_answer', { questionId: 'qq' })]);
    const m = cardsAndLists();
    expect(m.waiting).toEqual([0, 0]);
    expect(m.waitingAnswer).toEqual([1, 1]);
  });

  it('every card matches its list for a mix of every status, and still does after the stream reports a change', async () => {
    const jobs = [
      job('w1', 'queued'), job('w2', 'held', { holdReason: 'no lane' }), job('q1', 'waiting_answer', { questionId: 'qq' }),
      job('r1', 'running', { laneId: 'm1/lane-1', startedAt: hoursAgo(1) }), job('c1', 'claimed', { laneId: 'm1/lane-2' }),
      job('f1', 'finished', { finishedAt: hoursAgo(3) }), job('f2', 'finished', { finishedAt: hoursAgo(5) }),
      job('x1', 'failed', { finishedAt: hoursAgo(4), error: 'boom' }), job('k1', 'cancelled', { finishedAt: hoursAgo(6) }),
    ];
    const daemon = await boot(jobs);
    const before = cardsAndLists();
    expect(agree(before)).toEqual({ running: true, waiting: true, waitingAnswer: true, finished: true, failed: true });
    expect(before).toMatchObject({ running: [2, 2], waiting: [2, 2], waitingAnswer: [1, 1], finished: [2, 2], failed: [1, 1] });

    // The daemon moves on: w1 starts, r1 finishes. The stream says so; the store refreshes.
    daemon.setJobs(jobs.map((j) => j.id === 'w1' ? { ...j, status: 'running' as const, laneId: 'm1/lane-2', startedAt: hoursAgo(0) }
      : j.id === 'r1' ? { ...j, status: 'finished' as const, finishedAt: hoursAgo(0) } : j));
    await act(async () => {
      streams[0]!.listeners.get('job.finished')!({ data: JSON.stringify({ seq: 1, schemaVersion: 1, id: '1', type: 'job.finished', at: hoursAgo(0), jobId: 'r1', data: {} }) });
    });
    await vi.waitFor(() => expect(card('finished')).toBe(3));
    const after = cardsAndLists();
    expect(agree(after)).toEqual({ running: true, waiting: true, waitingAnswer: true, finished: true, failed: true });
    expect(after).toMatchObject({ running: [2, 2], waiting: [1, 1], finished: [3, 3] });
  });
});
