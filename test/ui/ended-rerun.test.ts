// @vitest-environment happy-dom
// Issue #362: the Ended panel offers Run again only where the daemon takes it. A failed job whose
// issue is closed shows why instead of the button, and a source's sync — which tells a job its issue
// closed or reopened — refreshes the jobs. The overview renders inside the whole app against a fake of
// the daemon's HTTP surface and a fake SSE.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/domain/types.ts';

const failed = (id: string, sync: Record<string, unknown>): Job => ({
  id, spec: { executor: 'test', payload: {} }, priority: 50, status: 'failed', approved: false, attempts: 1,
  createdAt: new Date(Date.now() - 600_000).toISOString(), updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  source: { source: 'github', kind: 'github', key: `https://github.com/owner/repo/issues/${id}` },
  sourceState: { sync: { claimReported: true, finalReported: true, ...sync } },
} as Job);

let ended: Job[] = [];
let sources: ((m: MessageEvent) => void) | undefined;

function fakeDaemon() {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [], waitingAnswer: [], ended }),
    '/api/machines': () => ({ machines: [] }),
    '/api/decisions': () => ({ decisions: [] }), '/api/events': () => ({ events: [] }),
    '/api/webhooks': () => ({ subscriptions: [] }), '/api/webhooks/deliveries': () => ({ deliveries: [] }),
    '/api/questions': () => ({ questions: [] }), '/api/sources': () => ({ sources: [] }),
    '/api/usage': () => ({ readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }), '/api/accounts': () => ({ accounts: [] }),
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json({ authenticated: true, user: { role: 'operator', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    return path in routes ? json(routes[path]!()) : new Response('{"error":"not found"}', { status: 404 });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(type: string, fn: (m: MessageEvent) => void): void { if (type === 'source.updated') sources = fn; }
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
  await vi.waitFor(() => expect(document.querySelector('[data-overview-panel="ended"] [data-job-id]')).not.toBeNull());
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-overview-panel="ended"] [data-job-id="${id}"]`)!;
const runAgain = (id: string) => [...row(id).querySelectorAll('button')].find((b) => b.textContent?.includes('Run again'));

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  sources = undefined;
  vi.unstubAllGlobals();
});

describe('Run again in the Ended panel (issue #362)', () => {
  it('is offered on a failed job whose issue is open, and not on one whose issue is closed: that one says to reopen it', async () => {
    ended = [failed('1', { itemClosed: false }), failed('2', { itemClosed: true })];
    await boot();
    expect(runAgain('1')).toBeDefined();
    expect(row('1').querySelector('[data-rerun-blocked]')).toBeNull();
    expect(runAgain('2')).toBeUndefined();
    expect(row('2').querySelector('[data-rerun-blocked]')?.textContent).toMatch(/issue is closed: reopen it to run it again/);
  });

  it('is not offered while the job\'s failure is not reported to its source yet', async () => {
    ended = [failed('1', { finalReported: false })];
    await boot();
    expect(runAgain('1')).toBeUndefined();
  });

  it('follows the issue after a source syncs: closed after the page loaded, the button goes', async () => {
    ended = [failed('1', { itemClosed: false })];
    await boot();
    expect(runAgain('1')).toBeDefined();
    ended = [failed('1', { itemClosed: true })];
    await act(async () => sources?.(new MessageEvent('source.updated', { data: JSON.stringify({ name: 'github', kind: 'github', state: 'ok', itemsSeen: 0, jobsCreated: 0, activeJobs: 0, detail: {} }) })));
    await vi.waitFor(() => expect(runAgain('1')).toBeUndefined());
    expect(row('1').querySelector('[data-rerun-blocked]')).not.toBeNull();
  });
});
