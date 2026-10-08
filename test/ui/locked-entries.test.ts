// @vitest-environment happy-dom
// Issue #355: a failed job is a locked entry. The Overview's Waiting panel lists the locked entries
// (rendered in happy-dom inside the whole app against a fake of the daemon's HTTP surface), each with
// its failure, Run again and Dismiss.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const failedJob = (id: string, o: Record<string, unknown> = {}) => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status: 'failed', approved: false, error: `${id} broke`,
  source: { source: 'github', kind: 'github', key: `https://github.com/o/r/issues/${id}` }, sourceState: { sync: { claimReported: true, finalReported: true } },
  createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z', finishedAt: '2026-10-03T10:05:00Z', attempts: 1, ...o,
});

const posts: string[] = [];

function fakeDaemon(locked: ReturnType<typeof failedJob>[]) {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': {
      waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked,
      gate: { mode: 'review', autoAcceptPerHour: null }, presort: { sorter: 'oldest-first', jobIds: [], reject: [] },
    },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path.startsWith('/ui/api/jobs/')) { posts.push(path); return json(200, {}); }
    if (path in routes) return json(200, routes[path]);
    return json(404, { error: 'not found' });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot(locked: ReturnType<typeof failedJob>[]) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon(locked));
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  posts.length = 0;
  vi.unstubAllGlobals();
});

const row = (id: string) => document.querySelector(`[data-job-group="locked"][data-job-id="${id}"]`);

describe('Locked entries in the Waiting panel', () => {
  it('each locked entry shows as locked, with its failure and the attempt it runs again', async () => {
    await boot([failedJob('f1'), failedJob('f2', { rerunOf: 'f0aaaaaa-0000' })]);
    await vi.waitFor(() => expect(row('f1')).not.toBeNull());
    expect(row('f1')!.textContent).toContain('locked');
    expect(row('f1')!.textContent).toContain('f1 broke');
    expect(row('f2')!.textContent).toContain('f0aaaaaa');
  });

  it('Run again and Dismiss post to the daemon', async () => {
    await boot([failedJob('f1')]);
    const buttons = await vi.waitFor(() => { const r = row('f1'); expect(r).not.toBeNull(); return [...r!.querySelectorAll('button')]; });
    const press = async (label: string) => act(async () => { buttons.find((b) => b.textContent?.includes(label))!.click(); });
    await press('Run again');
    await press('Dismiss');
    await vi.waitFor(() => expect(posts).toEqual(['/ui/api/jobs/f1/rerun', '/ui/api/jobs/f1/dismiss']));
  });
});
