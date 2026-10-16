// @vitest-environment happy-dom
// Issue #1380: the job view (#job/<id>) names the GitHub identity that acts for the job, rendered inside the whole app
// against a fake of the daemon's HTTP surface.
//
// Feature: the acting identity on the job page
//   Scenario: a job that acted on GitHub names the login its requests named
//   Scenario: a job that has not acted names its user's connected account, which will act
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/domain/types.ts';

const T = '2026-10-15T10:00:00.000Z';
const job = (id: string) => ({
  id, spec: { executor: 'test', payload: {}, goal: 'Fix the bug' }, priority: 50, status: 'finished', approved: true, attempts: 1,
  createdAt: T, updatedAt: T, finishedAt: T, source: { source: 'github', kind: 'issue', key: `https://github.invalid/acme/app/issues/${id}`, repo: 'acme/app', number: 7 },
} as unknown as Job);
const acted = { seq: 9, type: 'github_proxy.done', schemaVersion: 1, at: T, jobId: 'j1', data: { requestId: 'r1', as: 'job-user-login', op: 'pr.create', repo: 'acme/app', number: 12, url: 'https://github.invalid/acme/app/pull/12' } };

function fakeDaemon() {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [job('j1'), job('j2')], locked: [] }),
    '/api/machines': () => ({ machines: [] }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [acted] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/api/connected-accounts': () => ({ accounts: [{ provider: 'github', via: 'device', state: 'connected', account: 'connected-login', connectedAt: T, jobRepositories: ['acme/app'] }] }),
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'operator', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
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

async function boot(id: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = `#job/${id}`;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector(`[data-slot="job-view"][data-job-id="${id}"]`)).not.toBeNull());
}

const actingAs = () => document.querySelector<HTMLElement>('[data-slot="job-acting-as"]')?.textContent ?? '';

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the GitHub identity that acts for a job, on its page (issue #1380)', () => {
  it('a job that acted names the login its requests named', async () => {
    await boot('j1');
    await vi.waitFor(() => expect(actingAs()).toBe('job-user-login'));
  });

  it('a job that has not acted names its user\'s connected account, which will act', async () => {
    await boot('j2');
    await vi.waitFor(() => expect(actingAs()).toBe('connected-login (your connected GitHub account; it has not acted for this job yet)'));
  });
});
