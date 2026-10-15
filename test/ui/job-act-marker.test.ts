// @vitest-environment happy-dom
// Issue #1238, the last part: a person's act on a job — Merge now, Close PR, a give-back — shows on its pull request's
// card and on the job from its GitHub outbox row (the source's `detail.jobActs`), as an intake item shows its write: on
// its way, on its way again after a refusal for now, or failed with why. A job with no row not sent shows nothing.
//
// Feature: a job act's marker from the GitHub outbox
//   Scenario: the Pull requests card shows Merge now failed, with why
//   Scenario: the ended job shows its Run again on its way again, with the error of the try before
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job, JobActMarker, SourceStatus } from '../../src/domain/types.ts';
import { boot as bootPullRequests, cardOf, fixture, text } from './pull-requests-view-harness.ts';

const source = (jobActs: Record<string, JobActMarker>): SourceStatus => ({ name: 'github', kind: 'github-account', state: 'ok', detail: { jobActs } });

describe('the marker of a job act on the Pull requests card (issue #1238)', () => {
  it('a failed Merge now shows on its card with why; another card shows nothing', async () => {
    await bootPullRequests(fixture, 'admin', { repos: [] }, [source({ j1: { act: 'merge', state: 'failed', error: 'Pull Request is not mergeable (HTTP 405)' } })]);
    await vi.waitFor(() => expect(text('[data-slot="job-act"]', cardOf('j1'))).toBe('Merge now failed on GitHub: Pull Request is not mergeable (HTTP 405). Press it again to send it again.'));
    expect(cardOf('j1').querySelector('[data-slot="job-act"]')!.getAttribute('data-job-act')).toBe('failed');
    expect(cardOf('j3').querySelector('[data-slot="job-act"]')).toBeNull();
  });
});

const ended = {
  id: 'j9', spec: { executor: 'test', payload: {}, goal: 'Fix the flag' }, priority: 50, status: 'failed', approved: true, attempts: 1,
  createdAt: '2026-10-12T10:00:00.000Z', updatedAt: '2026-10-12T11:00:00.000Z', finishedAt: '2026-10-12T11:00:00.000Z',
  source: { source: 'github', kind: 'issue', key: 'https://github.invalid/acme/app/issues/7', repo: 'acme/app', number: 7 },
} as unknown as Job;

let root: Root | undefined;

async function bootJob(sources: SourceStatus[]) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#job/j9';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [ended], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'operator', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    return path in routes ? json(routes[path]) : new Response('{"error":"not found"}', { status: 404 });
  }));
  vi.stubGlobal('EventSource', class { onopen = null; onerror = null; addEventListener(): void {} close(): void {} });
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-slot="job-view"][data-job-id="j9"]')).not.toBeNull());
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the marker of a job act on the ended job (issue #1238)', () => {
  it('a Run again on its way again shows its next attempt and the error of the try before', async () => {
    await bootJob([source({ j9: { act: 'rerun', state: 'running', attempt: 2, error: 'GitHub is out of reach' } })]);
    await vi.waitFor(() => expect(text('[data-slot="job-act"]')).toBe('Run again: on its way to GitHub, try 2 (GitHub is out of reach)'));
    expect(document.querySelector('[data-slot="job-act"]')!.getAttribute('data-job-act')).toBe('running');
  });

  it('a job with no act on its way shows nothing', async () => {
    await bootJob([source({ other: { act: 'merge', state: 'running' } })]);
    await vi.waitFor(() => expect(document.querySelector('[data-slot="job-view"]')!.textContent).toContain('Fix the flag'));
    expect(document.querySelector('[data-slot="job-act"]')).toBeNull();
  });
});
