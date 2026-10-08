// @vitest-environment happy-dom
// Issue #381: the Overview's lanes and waiting list say what is really happening. A lane whose job
// still runs shows busy — one that closes after it says so in neutral words; a progress bar only when
// a real percentage exists; a job waiting for capacity reads "waiting for a lane", not held, with the
// limit that binds; and every state badge in both panels says what it means on hover.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job, JobStatus } from '../../src/domain/types.ts';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const job = (id: string, status: JobStatus, o: Partial<Job> = {}): Job => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status, approved: false,
  createdAt: minutesAgo(30), updatedAt: minutesAgo(1), attempts: 1, ...o,
} as Job);

const jobs = [
  job('r1', 'running', { laneId: 'm1/lane-1', startedAt: minutesAgo(25), progressMessage: 'running the tests' }),
  job('r2', 'running', { laneId: 'm1/lane-2', startedAt: minutesAgo(5), progress: 0.4 }),
  job('w1', 'queued', { waitReason: 'waiting for a lane: machine m1\'s lane cap is 2, all 2 in use' }),
  job('h1', 'held', { holdReason: 'router ask_human: awaiting approval' }),
];

function fakeDaemon() {
  const of = (...s: JobStatus[]) => jobs.filter((j) => s.includes(j.status));
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: of('queued', 'held'), running: of('claimed', 'running'), operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [{ id: 'm1', label: 'm1', maxLanes: 2, online: true, executors: ['test'], usage: [], lanes: [
      { id: 'm1/lane-1', machineId: 'm1', state: 'draining', jobId: 'r1', openedAt: minutesAgo(25) },
      { id: 'm1/lane-2', machineId: 'm1', state: 'busy', jobId: 'r2', openedAt: minutesAgo(5) },
    ] }] },
    '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json({ authenticated: true, user: { role: 'viewer', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
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

const lane = (jobId: string) => document.querySelector<HTMLElement>(`[data-lane-job="${jobId}"]`)!;
const waiting = (jobId: string) => document.querySelector<HTMLElement>(`[data-job-group="waiting"][data-job-id="${jobId}"]`)!;
const badges = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-slot="status-badge"]')];

describe('Overview lane and queue states', () => {
  it('a lane that closes after its running job shows busy and says it closes after this job, not draining', async () => {
    await boot();
    const card = lane('r1');
    expect(badges(card).map((b) => b.textContent)).toEqual(['busy']);
    expect(card.textContent).toContain('closes after this job');
    expect(card.textContent).not.toContain('draining');
  });

  it('no progress bar without a real percentage: elapsed time and the latest activity instead', async () => {
    await boot();
    const card = lane('r1');
    expect(card.querySelector('[data-slot="progress"]')).toBeNull();
    expect(card.textContent).not.toContain('0%');
    expect(card.textContent).toContain('25m');
    expect(card.textContent).toContain('running the tests');
    expect(lane('r2').querySelector('[data-slot="progress"]')?.textContent).toContain('40%');
  });

  it('a job waiting for capacity reads waiting for a lane with the binding limit; held stays for a real hold', async () => {
    await boot();
    expect(badges(waiting('w1')).map((b) => b.textContent)).toEqual(['waiting for a lane']);
    expect(waiting('w1').textContent).toContain('machine m1\'s lane cap is 2, all 2 in use');
    expect(waiting('w1').textContent).not.toContain('held');
    expect(badges(waiting('h1')).map((b) => b.textContent)).toEqual(['held']);
  });

  it('every state badge in the lanes and waiting panels says what it means on hover', async () => {
    await boot();
    const all = [lane('r1'), lane('r2'), waiting('w1'), waiting('h1')].flatMap(badges);
    expect(all.length).toBeGreaterThanOrEqual(4);
    for (const b of all) expect(b.title, b.textContent ?? '').not.toBe('');
  });
});
