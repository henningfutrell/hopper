// @vitest-environment happy-dom
// Issue #2932: a machine's removal was refused for jobs on their own wait that no view showed. Its Machines card lists the jobs
// that hold it, each a link to its job, and a job on its own wait has Release the wait, which asks first, then posts.
//
// Feature: the jobs that hold a machine
//   Scenario: the card lists each job that holds the machine, with a link and why
//   Scenario: Release the wait asks first, then posts; a running job has no such button
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const AT = '2026-11-12T10:00:00.000Z';
const WAITER = { id: 'wait-job-1', status: 'waiting_on', priority: 50, createdAt: AT, updatedAt: AT, attempts: 1, spec: { executor: 'herdr-claude', prompt: 'Deploy it', goal: 'Deploy the app', env: {} }, wait: { since: AT, for: 'a vault grant', on: { kind: 'vault_grant' } }, resumeOn: 'desk' };
const MACHINES = [{
  id: 'desk', label: 'desk', maxLanes: 2, online: true, executors: ['herdr-claude'], lanes: [], usage: [],
  holding: [{ jobId: 'wait-job-1', status: 'waiting_on', release: true }, { jobId: 'run-job-2', status: 'running' }],
}];

let calls: { method: string; path: string; body?: unknown }[] = [];

function fakeDaemon() {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], waitingOn: [WAITER], ended: [], locked: [] }),
    '/api/machines': () => ({ machines: MACHINES }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/api/credential-check': () => ({ strict: false }),
    
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    calls.push({ method: init.method ?? 'GET', path, ...(init.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
    if (init.method === 'POST' && path.endsWith('/release-wait')) return json({ ...WAITER, waitReleased: { at: AT, machineId: 'desk', checkpointAt: AT } });
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
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

async function boot() {
  calls = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#machines';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-slot="machine-holds"]')).not.toBeNull());
}

const holds = (): HTMLElement => document.querySelector<HTMLElement>('[data-slot="machine-holds"]')!;
const buttonIn = (el: HTMLElement, text: RegExp) => [...el.querySelectorAll('button')].find((b) => text.test(b.textContent ?? '')) as HTMLButtonElement | undefined;
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.path === path);

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the jobs that hold a machine (issue #2932)', () => {
  it('lists each job that holds the machine, with a link to it and why', async () => {
    await boot();
    const items = [...holds().querySelectorAll('li')];
    expect(items.map((li) => li.dataset.job)).toEqual(['wait-job-1', 'run-job-2']);
    expect(items[0]!.querySelector('a')!.getAttribute('href')).toBe('#job/wait-job-1');
    expect(items[0]!.textContent).toContain('Deploy the app');
    expect(items[0]!.textContent).toContain('on its own wait, its session on this machine');
    expect(items[1]!.textContent).toContain('runs here');
    expect(holds().textContent).toContain('A removal or rename waits for these 2 jobs.');
  });

  it('Release the wait asks first, then posts; a running job has no such button', async () => {
    await boot();
    const items = [...holds().querySelectorAll('li')];
    expect(buttonIn(items[1]!, /Release the wait/)).toBeUndefined();
    await act(async () => { buttonIn(items[0]!, /Release the wait/)!.click(); });
    const dialog = await vi.waitFor(() => { const d = document.querySelector<HTMLElement>('[role="alertdialog"]'); expect(d).not.toBeNull(); return d!; });
    expect(dialog.textContent).toContain('resumes its session on another machine');
    expect(posts('/ui/api/jobs/wait-job-1/release-wait')).toEqual([]);
    await act(async () => { buttonIn(dialog, /^Release the wait$/)!.click(); });
    await vi.waitFor(() => expect(posts('/ui/api/jobs/wait-job-1/release-wait')).toHaveLength(1));
  });
});
