// @vitest-environment happy-dom
// Issue #946, part 2: Promote to GitHub from the job view (#job/<id>, issue #935) as well as from Direct jobs. A direct
// job's job shows its direct job's promotion part — the offer, the promotion and Promote to GitHub — under its facts,
// rendered inside the whole app against a fake of the daemon's HTTP surface. A job from an issue shows none.
//
// Feature: Promote to GitHub from the job view
//   Scenario: a finished direct job's job offers its promotion, and previews it for the direct job
//   Scenario: a job from an issue shows no promotion part
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/domain/types.ts';

const direct = {
  id: 'j3', spec: { executor: 'test', payload: {}, goal: 'Why was a sign-in locked?' }, priority: 50, status: 'finished', approved: true, attempts: 1,
  createdAt: '2026-10-12T10:00:00.000Z', updatedAt: '2026-10-12T11:00:00.000Z', finishedAt: '2026-10-12T11:00:00.000Z',
  source: { source: 'direct', kind: 'direct', key: 'direct:d3', title: 'Why was a sign-in locked?' },
} as unknown as Job;
const fromIssue = { ...direct, id: 'j4', source: { source: 'github', kind: 'issue', key: 'https://github.invalid/acme/app/issues/7', repo: 'acme/app', number: 7 } } as unknown as Job;
const ART = { id: 'a1', title: 'Lockout timeline', summary: 'When each sign-in failed', kind: 'svg', revision: 1, url: 'http://hopper.invalid/#artifacts/a1', commit: { branch: 'hopper-promotion/d3', path: 'hopper-promotions/d3/a1-timeline.svg' } };
const D3 = {
  id: 'd3', title: 'Why was a sign-in locked?', brief: 'Find out why.', labels: [], authorizations: [], repo: 'octo-org/hello', artifacts: [ART], offer: 'suggested',
  submittedBy: { person: 'ada', via: 'ui' }, submittedAt: '2026-10-12T10:00:00.000Z', job: { id: 'j3', status: 'finished', questions: [] },
};
const DRAFT = {
  repo: 'octo-org/hello', visibility: 'private', target: { kind: 'issue' }, title: 'Why was a sign-in locked?', body: 'Find out why.', labels: [], artifacts: [ART],
  includeRequester: false, footer: '---', findings: [], notes: [],
};

let calls: { method: string; path: string; body?: unknown }[] = [];

function fakeDaemon() {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [direct, fromIssue], locked: [] }),
    '/api/machines': () => ({ machines: [] }), '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
    '/api/direct-jobs/d3': () => D3,
    '/ui/api/direct-jobs/d3/promotion/preview': () => DRAFT,
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = String(input).split('?')[0]!;
    calls.push({ method: init.method ?? 'GET', path, ...(init.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) });
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
  calls = [];
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

const button = (text: RegExp) => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''));

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Promote to GitHub from the job view (issue #946)', () => {
  it('offers a finished direct job\'s promotion on its job\'s page, and previews it for the direct job', async () => {
    await boot('j3');
    await vi.waitFor(() => expect(document.querySelector('[data-slot="job-promotion"]')).not.toBeNull());
    const part = document.querySelector<HTMLElement>('[data-slot="job-promotion"]')!;
    expect(part.textContent).toContain('It made an artifact you may want to share');
    expect(part.querySelector('a[href="#ask"]')).not.toBeNull();
    await act(async () => { button(/Promote to GitHub/)!.click(); });
    await act(async () => { button(/Preview/)!.click(); });
    await vi.waitFor(() => expect(document.querySelector('[data-slot="promote-preview"]')).not.toBeNull());
    expect(calls.find((c) => c.path.endsWith('/promotion/preview'))).toEqual({ method: 'POST', path: '/ui/api/direct-jobs/d3/promotion/preview', body: { repo: 'octo-org/hello', target: { kind: 'issue' } } });
  });

  it('shows no promotion part for a job from an issue', async () => {
    await boot('j4');
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(document.querySelector('[data-slot="job-promotion"]')).toBeNull();
    expect(calls.some((c) => c.path.startsWith('/api/direct-jobs'))).toBe(false);
  });
});
