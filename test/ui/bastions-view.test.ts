// @vitest-environment happy-dom
// Access requests, "Bastions" (issue #2146, design.md "Bastions"), rendered in happy-dom inside the whole app against a
// fake of the daemon's HTTP surface: each bastion of a job that runs is a card — its template, its job, its targets,
// its state and when its TTL ends —, with Stop, which posts the stop of the job's bastion. With none, the panel says so.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const JOB = 'de987f4a-0000-4000-8000-000000000001';
const BASTION = {
  id: 'b1b2b3b4-0000-4000-8000-000000000001', jobId: JOB, template: 'observe-utility', box: 'hopper-bastion-observe-utility-b1b2b3b4',
  targets: [{ target: 'utility/monitoring/svc/grafana:80', local: 20000 }, { target: 'utility/monitoring/svc/prometheus-server:9090', local: 20001 }],
  state: 'running', startedAt: '2026-10-20T12:00:00.000Z', expiresAt: '2026-10-20T13:00:00.000Z', log: '[utility/monitoring/svc/grafana:80] Forwarding from 127.0.0.1:20000 -> 3000\n',
};
let VIEW: Record<string, unknown> = { secrets: [], templates: [], bastions: [BASTION] };

interface Call { path: string; method: string; body?: Record<string, unknown> }

function fakeDaemon() {
  const calls: Call[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/questions': { questions: [] },
    '/api/sources': { sources: [] }, '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/vault': VIEW,
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, method: init.method ?? 'GET', ...(body ? { body } : {}) });
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'github', name: 'alice', instanceAdmin: true }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/ui/api/bastions/stop') return json(200, { ...VIEW, bastions: [] });
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
  return { fetch, calls };
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
  window.location.hash = '#access-requests';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon();
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(panel()).not.toBeNull());
  return daemon;
}

const panel = (): HTMLElement | null => document.querySelector('[data-access-panel="bastions"]');
const card = (): HTMLElement | null => document.querySelector('[data-bastion]');
const button = (in_: HTMLElement, text: string): HTMLButtonElement => [...in_.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)! as HTMLButtonElement;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Access requests: the bastions of jobs (issue #2146)', () => {
  it('shows each bastion that runs, its template, job and targets; Stop posts the stop of the job\'s bastion', async () => {
    VIEW = { secrets: [], templates: [], bastions: [BASTION] };
    const daemon = await boot();
    await vi.waitFor(() => expect(card()).not.toBeNull());
    const c = card()!;
    expect(c.textContent).toContain('observe-utility');
    expect(c.textContent).toContain('running');
    expect(c.textContent).toContain(JOB.slice(0, 8));
    expect(c.querySelector(`a[href="#job/${JOB}"]`)).not.toBeNull();
    expect(c.textContent).toContain('utility/monitoring/svc/grafana:80');
    expect(c.textContent).toContain('utility/monitoring/svc/prometheus-server:9090');
    expect(c.textContent).toContain('2026-10-20 13:00');
    await act(async () => { button(c, 'Stop').click(); });
    await vi.waitFor(() => expect(daemon.calls.find((x) => x.path === '/ui/api/bastions/stop')).toMatchObject({ method: 'POST', body: { job: JOB } }));
    await vi.waitFor(() => expect(card()).toBeNull());
  });

  it('says so when no bastion runs', async () => {
    VIEW = { secrets: [], templates: [] };
    await boot();
    expect(panel()!.textContent).toContain('No bastion runs');
  });
});
