// The Pull requests view's harness (issue #637): the whole app rendered against a fake of the daemon's HTTP surface, with
// a fixture of cards. Shared by the view's tests.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, vi } from 'vitest';
import type { PullRequestCard, PullRequestsView, RepoChecks, RepoChecksView, SourceStatus } from '../../src/domain/types.ts';

export const card = (over: Partial<PullRequestCard>): PullRequestCard => ({
  jobId: 'j1', repo: 'owner/a', issue: { number: 10, url: 'https://github.com/owner/a/issues/10' },
  pullRequest: { number: 11, url: 'https://github.com/owner/a/pull/11' }, part: false, state: 'open', checks: 'passing',
  mergeable: 'mergeable', draft: false, openedAt: '2026-10-08T10:00:00.000Z', yolo: false, waits: 'yolo off', ...over,
});

export const fixture: PullRequestsView = {
  yolo: { on: 2, total: 3 },
  waiting: [{ repo: 'owner/a', count: 2, reason: 'yolo off' }, { repo: 'org/b', count: 1, reason: 'checks pending' }],
  repos: [
    { repo: 'owner/a', yolo: false, pullRequests: [card({}), card({ jobId: 'j2', part: true, pullRequest: undefined, openedAt: undefined, since: '2026-10-08T11:00:00.000Z' })] },
    { repo: 'org/b', yolo: true, pullRequests: [card({ jobId: 'j3', repo: 'org/b', yolo: true, checks: 'pending', waits: 'checks pending' })] },
    { repo: 'org/c', yolo: true, pullRequests: [card({ jobId: 'j4', repo: 'org/c', yolo: true, state: 'closed', waits: undefined, mergeable: 'conflicts', mergeError: 'Base branch was modified' })] },
  ],
};

export const repoChecks = (repo: string, over: Partial<RepoChecks> = {}): RepoChecks => ({
  repo, state: 'checks', yolo: false, dismissed: false, checkedAt: '2026-10-08T10:00:00.000Z',
  found: { required: ['test'], workflows: [], pullRequests: { read: 3, withChecks: 3 } }, setup: { state: 'set up', problems: [], unread: [] }, ...over,
});
export const noChecks = { found: { required: [], workflows: [], pullRequests: { read: 2, withChecks: 0 } }, state: 'no checks' as const, yolo: true };
export const checksFixture: RepoChecksView = {
  repos: [
    repoChecks('owner/a'),
    repoChecks('org/b', { ...noChecks, recommendation: { title: 'Add PR checks to org/b' } }),
    repoChecks('org/c', { ...noChecks, recommendation: { title: 'Add PR checks to org/c', queued: { number: 7, url: 'https://github.com/org/c/issues/7' } } }),
  ],
};

/** What the fake daemon answers a `POST /ui/api/…` path; any other answers `{}`. Cleared after each test. */
export const uiAnswers: Record<string, unknown> = {};

function fakeDaemon(view: PullRequestsView, role: 'viewer' | 'admin', checks: RepoChecksView, sources: SourceStatus[]) {
  const bodies: { path: string; body: unknown }[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/sources': { sources },
    '/api/questions': { questions: [] }, '/api/accounts': { accounts: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] },
    '/api/pull-requests': view, '/api/repo-checks': checks,
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const [path] = String(input).split('?') as [string];
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role, realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path.startsWith('/ui/api/')) { bodies.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined }); return json(200, uiAnswers[path] ?? {}); }
    return json(200, routes[path] ?? {});
  });
  return { fetch, bodies };
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

/** `kept`: a reload, with what the browser kept (issue #2353); else a browser that kept nothing. */
export async function boot(view: PullRequestsView, role: 'viewer' | 'admin' = 'admin', checks: RepoChecksView = { repos: [] }, sources: SourceStatus[] = [], kept = false) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#pull-requests';
  if (!kept) localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon(view, role, checks, sources);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-slot="pr-yolo-line"]')).not.toBeNull());
  return daemon;
}

export const text = (sel: string, el: ParentNode = document) => el.querySelector(sel)?.textContent ?? '';
export const cardOf = (jobId: string) => document.querySelector(`[data-pull-request="${jobId}"]`)!;

/** Unmount the app booted last. */
export async function unmount(): Promise<void> {
  await act(async () => root?.unmount());
}

afterEach(async () => {
  await unmount();
  root = undefined;
  for (const k of Object.keys(uiAnswers)) delete uiAnswers[k];
  vi.unstubAllGlobals();
});

