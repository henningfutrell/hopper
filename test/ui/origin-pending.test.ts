// @vitest-environment happy-dom
// Issue #652, the backfill, rendered inside the whole app against a fake of the daemon's HTTP surface: a job queued
// before origins were judged is held for its origin under Waiting. Approve is not offered, for no approval of the job
// starts it; the row says why and links to Sources, where its issue's request card is approved.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Role = 'viewer' | 'admin';
const T = '2026-10-09T12:00:00.000Z';
const heldJob = {
  id: 'h1', spec: { executor: 'herdr-claude', payload: { body: 'Fix the bug.' }, goal: 'Fix the bug' }, priority: 50, status: 'held', approved: false, attempts: 0,
  holdReason: 'queued before trusted origins: held until its issue is judged — approve its request card in Intake, or cancel it',
  originPending: true,
  createdAt: T, updatedAt: T, source: { source: 'github', kind: 'github-account', key: 'k-h1', title: 'Fix the bug', repo: 'o/r', number: 7 },
};

function fakeDaemon(role: Role) {
  const posts: { path: string; body: unknown }[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['herdr-claude'], parkingExecutors: ['herdr-claude'], uptimeS: 1 },
    '/api/queue': { waiting: [heldJob], running: [], operatorLed: [], ended: [], locked: [], highPriority: 75, waitingAnswer: [], parked: [], waitingOn: [] },
    '/api/machines': { machines: [{ id: 'desk', label: 'desk', maxLanes: 2, online: true, executors: ['herdr-claude'], lanes: [], usage: [] }] },
    '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/sources': { sources: [] },
    '/api/questions': { questions: [] },
    '/api/accounts': { accounts: [] }, '/api/usage': { readings: [], sources: [], machines: [], limits: { soft: 0.7, hard: 0.95, defaults: { soft: 0.7, hard: 0.95 }, set: false } },
    '/api/logins': { now: T, settings: { onExpiry: 'fail', warnSec: 60 }, logins: [] },
    '/api/usage/history': { view: { range: { preset: '24h' } }, from: '2026-10-08T12:00:00.000Z', to: T, stepMs: 900000, retentionDays: 90, series: [] },
    '/api/machines/history': { view: { range: { preset: '24h' } }, from: '2026-10-08T12:00:00.000Z', to: T, stepMs: 900000, retentionDays: 90, series: [] },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const [path] = String(input).split('?') as [string];
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role, realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path.startsWith('/ui/api/')) { posts.push({ path, body: JSON.parse(String(init.body ?? '{}')) }); return json(200, {}); }
    return json(200, routes[path] ?? {});
  });
  return { fetch, posts };
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;
let daemon: ReturnType<typeof fakeDaemon>;

async function boot(role: Role, hash: string) {
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  daemon = fakeDaemon(role);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx';
  const mod = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(mod.App)); });
  await settle();
}

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const buttonIn = (el: Element, label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const row = () => document.querySelector('[data-job-group="waiting"][data-job-id="h1"]');

describe('a job held for its origin (issue #652)', () => {
  it('offers no Approve, says why, and links to Intake', async () => {
    await boot('admin', '#overview');
    expect(row()).not.toBeNull();
    expect(buttonIn(row()!, 'Approve')).toBeUndefined();
    expect(row()!.textContent).toContain('queued before trusted origins');
    const link = row()!.querySelector('a[href="#intake"]');
    expect(link?.textContent).toContain('approve in Intake');
  });
});
