// @vitest-environment happy-dom
// Issues #362, #354: the Ended panel offers Run again only where the daemon takes it — a failed or
// finished job, its end reported, whether or not its issue is closed (Run again reopens it). The overview
// renders inside the whole app against a fake of the daemon's HTTP surface and a fake SSE.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../../src/domain/types.ts';

const failed = (id: string, sync: Record<string, unknown>, status: Job['status'] = 'failed'): Job => ({
  id, spec: { executor: 'test', payload: {} }, priority: 50, status, approved: false, attempts: 1,
  createdAt: new Date(Date.now() - 600_000).toISOString(), updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  source: { source: 'github', kind: 'github', key: `https://github.com/owner/repo/issues/${id}` },
  sourceState: { sync: { claimReported: true, finalReported: true, ...sync } },
} as Job);

let ended: Job[] = [];

function fakeDaemon() {
  const routes: Record<string, () => unknown> = {
    '/api/health': () => ({ ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 }),
    '/api/queue': () => ({ waiting: [], running: [], waitingAnswer: [], ended, locked: [] }),
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
  await vi.waitFor(() => expect(document.querySelector('[data-overview-panel="ended"] [data-job-id]')).not.toBeNull());
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-overview-panel="ended"] [data-job-id="${id}"]`)!;
const runAgain = (id: string) => [...row(id).querySelectorAll('button')].find((b) => b.textContent?.includes('Run again'));

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Run again in the Ended panel (issues #362, #354)', () => {
  it('is offered on a failed job and on a finished one, its end reported', async () => {
    ended = [failed('1', {}), failed('2', {}, 'finished')];
    await boot();
    expect(runAgain('1')).toBeDefined();
    expect(runAgain('2')).toBeDefined();
  });

  it('is offered on a rejected job: the user takes back a rejection (issue #387)', async () => {
    ended = [failed('1', {}, 'rejected')];
    await boot();
    expect(runAgain('1')).toBeDefined();
  });

  it('is not offered while the job\'s end is not reported to its source yet', async () => {
    ended = [failed('1', { finalReported: false })];
    await boot();
    expect(runAgain('1')).toBeUndefined();
  });
});
