// @vitest-environment happy-dom
// Issue #434: the Jobs view, rendered inside the whole app against a fake of the daemon's HTTP surface. A card per job
// with its status, issue (owner/repo#number), lane and last event; filters by status and by repository; a status change
// reaches its card live, through the event stream, with no reload; 250 jobs render.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DomainEvent, Job, JobStatus } from '../../src/domain/types.ts';

const REPOS = ['acme/widgets', 'acme/site', 'other-org/tools'];
const STATUSES: JobStatus[] = ['queued', 'running', 'waiting_answer', 'finished', 'failed'];

const pointed = (n: number, status: JobStatus): Job => {
  const repo = REPOS[n % REPOS.length]!;
  return {
    id: `job-${n}`, spec: { executor: 'test', payload: {}, goal: `goal ${n}` }, priority: 50, status, approved: false,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(), attempts: 1,
    ...(status === 'running' ? { laneId: `m1/lane-${n}` } : {}),
    source: { source: 'github', kind: 'issue', key: `https://github.com/${repo}/issues/${n}`, url: `https://github.com/${repo}/issues/${n}`, repo, number: n },
  } as Job;
};
const event = (seq: number, jobId: string, type: string): DomainEvent =>
  ({ seq, schemaVersion: 1, id: `e${seq}`, type, at: '2026-10-01T01:00:00Z', jobId, data: {} } as DomainEvent);

let jobs: Job[] = [];

function fakeDaemon() {
  const queue = () => {
    const of = (...s: JobStatus[]) => jobs.filter((j) => s.includes(j.status));
    return { waiting: of('queued'), running: of('claimed', 'running'), operatorLed: [], parked: [], waitingAnswer: of('waiting_answer'), ended: of('finished', 'failed'), locked: [] };
  };
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 }),
    '/api/queue': queue,
    '/api/machines': () => ({ machines: [{ id: 'm1', label: 'box', maxLanes: 300, online: true, executors: ['test'], usage: [], lanes: [] }] }),
    '/api/jobs/last-events': () => ({ events: jobs.map((j, i) => event(i + 1, j.id, 'job.queued')) }),
    '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'viewer', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    return path in routes ? json(routes[path]!()) : new Response('{"error":"not found"}', { status: 404 });
  });
}

class FakeEventSource {
  static last: FakeEventSource | undefined;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (m: { data: string }) => void>();
  constructor() { FakeEventSource.last = this; }
  addEventListener(type: string, fn: (m: { data: string }) => void): void { this.listeners.set(type, fn); }
  close(): void {}
  send(e: DomainEvent): void { this.listeners.get(e.type)?.({ data: JSON.stringify(e) }); }
}

let root: Root | undefined;

async function boot() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#jobs';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(cards().length).toBe(jobs.length));
}

const cards = () => [...document.querySelectorAll<HTMLElement>('[data-slot="job-card"]')];
const card = (id: string) => document.querySelector<HTMLElement>(`[data-slot="job-card"][data-job-id="${id}"]`)!;
const slot = (el: HTMLElement, name: string) => el.querySelector<HTMLElement>(`[data-slot="${name}"]`)?.textContent ?? '';

async function choose(name: string, value: string) {
  const select = document.querySelector<HTMLSelectElement>(`[data-slot="${name}"]`)!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the Jobs view (issue #434)', () => {
  it('has a nav entry', async () => {
    jobs = [pointed(1, 'queued')];
    await boot();
    expect(document.querySelector('nav a[href="#jobs"]')?.textContent).toContain('Jobs');
  });

  it('shows a card per job with its status, issue, lane and last event', async () => {
    jobs = [pointed(1, 'running'), pointed(2, 'queued')];
    await boot();
    const running = card('job-1');
    expect(running.dataset.status).toBe('running');
    expect(slot(running, 'card-issue')).toBe('acme/site#1');
    expect(running.querySelector<HTMLAnchorElement>('[data-slot="card-issue"] a')?.href).toBe('https://github.com/acme/site/issues/1');
    expect(slot(running, 'card-lane')).toBe('box (m1) · lane-1');
    await vi.waitFor(() => expect(slot(running, 'card-last-event')).toContain('job.queued'));
    expect(slot(card('job-2'), 'card-lane')).toBe('no lane');
    expect(running.querySelector<HTMLAnchorElement>('a[href="#job/job-1"]')).not.toBeNull();
  });

  it('filters by status and by repository, and says how many show', async () => {
    jobs = Array.from({ length: 30 }, (_, n) => pointed(n, STATUSES[n % STATUSES.length]!));
    await boot();
    await choose('jobs-filter-status', 'running');
    expect(cards().every((c) => c.dataset.status === 'running')).toBe(true);
    expect(cards()).toHaveLength(6);
    await choose('jobs-filter-repo', 'acme/widgets');
    expect(cards().map((c) => c.dataset.jobId)).toEqual(['job-21', 'job-6']);
    expect(document.querySelector('[data-slot="jobs-count"]')?.textContent).toContain('2 of 30');
    await choose('jobs-filter-status', '');
    expect(cards().every((c) => slot(c, 'card-issue').startsWith('acme/widgets#'))).toBe(true);
    expect(cards()).toHaveLength(10);
  });

  it('a status change reaches its card live, with no reload', async () => {
    jobs = Array.from({ length: 250 }, (_, n) => pointed(n, STATUSES[n % STATUSES.length]!));
    await boot();
    expect(card('job-0').dataset.status).toBe('queued');
    jobs = jobs.map((j) => (j.id === 'job-0' ? { ...j, status: 'running', laneId: 'm1/lane-0' } : j));
    await act(async () => { FakeEventSource.last!.send(event(1000, 'job-0', 'job.started')); });
    await vi.waitFor(() => expect(card('job-0').dataset.status).toBe('running'));
    expect(slot(card('job-0'), 'card-last-event')).toContain('job.started');
    expect(slot(card('job-0'), 'card-lane')).toBe('box (m1) · lane-0');
    expect(cards()).toHaveLength(250);
  });
});
