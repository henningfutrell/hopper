// @vitest-environment happy-dom
// Issue #752 in the Overview: a running job held because its machine's link dropped says so on its lane, with when
// it fails if the link is not back; a job on a live link says nothing of it. Its machine says it is out of reach. Renders the whole app against a fake of
// the daemon's HTTP surface and a fake SSE.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clock } from '../../ui/src/model/format.ts';
import type { Job, JobStatus } from '../../src/domain/types.ts';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const job = (id: string, status: JobStatus, o: Partial<Job> = {}): Job => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status, approved: false,
  createdAt: minutesAgo(30), updatedAt: minutesAgo(1), attempts: 1,
  source: { source: 'github', kind: 'github-account', key: `https://github.com/owner/repo/issues/${id}`, repo: 'owner/repo', number: 1, assignee: 'owner' }, ...o,
} as Job);

const jobs = [
  job('r1', 'running', { laneId: 'm1/lane-1', startedAt: minutesAgo(25), linkLost: { machine: 'm1', since: minutesAgo(1), failsAt: new Date(Date.now() + 60_000).toISOString() } }),
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
    ] }, { id: 'm2', label: 'm2', maxLanes: 1, online: true, executors: ['test'], usage: [], lanes: [] }] },
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

describe('a job held through a link outage (issue #752)', () => {
  it('its lane says held: link lost, and when it fails; a job on a live link says nothing of it', async () => {
    await boot();
    const held = document.querySelector('[data-job-group="running"][data-job-id="r1"] [data-link-lost]');
    expect(held?.textContent).toContain('held: link lost 1m ago');
    expect(held?.textContent).toContain(`fails at ${clock(jobs[0]!.linkLost!.failsAt)}`);
    expect(document.querySelector('[data-job-group="running"][data-job-id="r2"] [data-link-lost]')).toBeNull();
  });

  it('its machine says out of reach since when, and that the job is held; a machine with no held job says nothing of it', async () => {
    await boot();
    await act(async () => { window.location.hash = '#machines'; });
    const away = await vi.waitFor(() => {
      const el = document.querySelector('[data-machine-away="m1"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(away.textContent).toContain(`out of reach since ${clock(jobs[0]!.linkLost!.since)}`);
    expect(away.textContent).toContain('1 job held');
    expect(document.querySelector('[data-machine-away="m2"]')).toBeNull();
  });

  it('its own job page says held: link lost too', async () => {
    await boot();
    await act(async () => { window.location.hash = '#job/r1'; });
    const held = await vi.waitFor(() => {
      const el = document.querySelector('[data-slot="job-view"] [data-link-lost]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(held.textContent).toContain('held: link lost 1m ago');
  });
});
