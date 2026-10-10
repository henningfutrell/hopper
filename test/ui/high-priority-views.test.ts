// @vitest-environment happy-dom
// Issue #535, rendered inside the whole app against a fake of the daemon's HTTP surface: a high-priority job's question
// is first on Questions and tagged, and the Questions nav badge is marked; the Machines view shows the priority lanes —
// every lane's reliability, its rank and why — and an admin changes the settings or chooses the lanes by hand; a
// viewer reads only.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Role = 'viewer' | 'admin';
const T = '2026-10-09T12:00:00.000Z';
const job = (id: string, priority: number, title: string) => ({
  id, spec: { executor: 'test', payload: {} }, priority, status: 'waiting_answer', approved: true, attempts: 1, questionId: `q-${id}`,
  createdAt: T, updatedAt: T, source: { source: 'github', kind: 'github', key: `k-${id}`, title, repo: 'o/r', number: id === 'plain' ? 1 : 2 },
});
const question = (id: string, createdAt: string, priority: number, high: boolean) => ({
  id: `q-${id}`, jobId: id, text: `${id}?`, recentOutput: '', detectedBy: 'marker', status: 'open', tier: 'human', attempts: [], notifyCount: 1,
  createdAt, updatedAt: createdAt, seenAt: createdAt, priority, high,
});
const lane = (laneId: string, over: Record<string, unknown>) => ({
  laneId, machineId: 'desk', runs: 0, finished: 0, failed: 0, laneFaults: 0, recentFaults: 0, score: 0, priority: false, reason: 'not ranked: 0 of the 5 runs needed in 14 days', ...over,
});
const settings = { highPriority: 75, count: 1, whenIdle: 'keep-free', windowDays: 14, minRuns: 5 };
const priorityLanes = {
  settings, defaults: settings, chosen: ['desk/lane-2'], by: 'reliability', measuredAt: T, switchMargin: 0.1,
  lanes: [
    lane('desk/lane-1', { runs: 12, finished: 9, failed: 3, laneFaults: 3, score: 0.75, successRate: 0.75, medianStartMs: 20_000, rank: 2, reason: 'rank 2: the priority lane is more reliable' }),
    lane('desk/lane-2', { runs: 10, finished: 10, score: 1, successRate: 1, medianStartMs: 8_000, rank: 1, priority: true, reason: 'priority lane: rank 1, 100% of 10 runs without a lane fault' }),
  ],
};

function fakeDaemon(role: Role) {
  const posts: { path: string; body: unknown }[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: ['test'], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [job('urgent', 80, 'Fix the outage'), job('plain', 50, 'Tidy up')], ended: [], locked: [], highPriority: 75 },
    '/api/machines': { machines: [{ id: 'desk', label: 'desk', maxLanes: 2, online: true, executors: ['test'], lanes: [], usage: [] }] },
    '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/sources': { sources: [] },
    // Oldest first as the store holds them; the high-priority one is newer.
    '/api/questions': { questions: [question('plain', '2026-10-09T11:00:00.000Z', 50, false), question('urgent', '2026-10-09T11:30:00.000Z', 80, true)] },
    '/api/accounts': { accounts: [] }, '/api/usage': { readings: [], sources: [], machines: [], limits: { soft: 0.7, hard: 0.95, defaults: { soft: 0.7, hard: 0.95 }, set: false } },
    '/api/logins': { now: T, settings: { onExpiry: 'fail', warnSec: 60 }, logins: [] },
    '/api/priority-lanes': priorityLanes,
    // The resource graphs (issue #560): no machine samples.
    '/api/machines/history': { view: { range: { preset: '24h' } }, from: '2026-10-08T00:00:00.000Z', to: '2026-10-09T00:00:00.000Z', stepMs: 900000, retentionDays: 90, series: [] },
    // The sandbox boxes the hopper starts (issue #603): none it could not remove.
    '/api/sandboxes': { launch: { available: true }, problems: [] },
    '/api/machines/config': {
      version: 'v1', executors: ['test'], defaults: { lanes: 2, executors: ['test'] }, ssh: { targets: [], notes: [], here: [] },
      machines: [{ name: 'desk', plugin: 'local', options: { lanes: 2 } }],
    },
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const [path] = String(input).split('?') as [string];
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role, realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path === '/ui/api/priority-lanes/settings') {
      const body = JSON.parse(String(init.body ?? '{}')) as { manual?: string[] | null };
      posts.push({ path, body });
      return json(200, Array.isArray(body.manual) ? { ...priorityLanes, settings: { ...settings, manual: body.manual }, by: 'manual', chosen: body.manual } : priorityLanes);
    }
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
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
function type(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('a high-priority job\'s question', () => {
  it('is first on Questions, tagged high; the other is not; the Questions badge is marked', async () => {
    await boot('admin', '#questions');
    const cards = [...document.querySelectorAll('[data-question]')].map((c) => c.getAttribute('data-question'));
    expect(cards).toEqual(['q-urgent', 'q-plain']);
    expect(document.querySelector('[data-question="q-urgent"] [data-slot="high-priority"]')).not.toBeNull();
    expect(document.querySelector('[data-question="q-plain"] [data-slot="high-priority"]')).toBeNull();
    const badge = [...document.querySelectorAll('[data-slot="nav-badge"]')].find((b) => b.closest('a')?.getAttribute('href') === '#questions')!;
    expect(badge.getAttribute('data-high')).toBe('1');
    expect(badge.getAttribute('title')).toBe('2 questions wait on you; 1 high priority');
  });
});

describe('the priority lanes on Machines', () => {
  it('every lane with its reliability, rank and why; the priority lane marked', async () => {
    await boot('admin', '#machines');
    const rows = [...document.querySelectorAll('[data-priority-lane]')];
    expect(rows.map((r) => r.getAttribute('data-priority-lane'))).toEqual(['desk/lane-2', 'desk/lane-1']);
    expect(rows[0]!.textContent).toContain('100% without a lane fault · 10 runs · 0 lane faults');
    expect(rows[0]!.textContent).toContain('priority lane: rank 1, 100% of 10 runs without a lane fault');
    expect(rows[0]!.querySelector('[data-slot="priority-lane"]')).not.toBeNull();
    expect(rows[1]!.querySelector('[data-slot="priority-lane"]')).toBeNull();
    expect(document.querySelector('[data-slot="priority-lanes-summary"]')!.textContent)
      .toBe('High priority: 75 and above. 1 priority lane, chosen by reliability; kept free while no high-priority job waits.');
  });

  it('an admin saves a setting; Save posts only what changed', async () => {
    await boot('admin', '#machines');
    await act(async () => { type(document.getElementById('priority-lanes-count') as HTMLInputElement, '2'); });
    await act(async () => { button('Save')!.click(); });
    expect(daemon.posts).toEqual([{ path: '/ui/api/priority-lanes/settings', body: { count: 2 } }]);
  });

  it('an admin chooses the lanes by hand, and goes back to reliability', async () => {
    await boot('admin', '#machines');
    await act(async () => { (document.querySelector('[data-choose="desk/lane-1"]') as HTMLInputElement).click(); });
    await act(async () => { button('Use these lanes')!.click(); });
    expect(daemon.posts.at(-1)).toEqual({ path: '/ui/api/priority-lanes/settings', body: { manual: ['desk/lane-2', 'desk/lane-1'] } });
    await act(async () => { button('Choose by reliability')!.click(); });
    expect(daemon.posts.at(-1)).toEqual({ path: '/ui/api/priority-lanes/settings', body: { manual: null } });
  });

  it('a viewer reads only', async () => {
    await boot('viewer', '#machines');
    expect(document.querySelectorAll('[data-priority-lane]')).toHaveLength(2);
    expect(document.getElementById('priority-lanes-count')).toBeNull();
    expect(document.querySelector('[data-choose]')).toBeNull();
  });
});
