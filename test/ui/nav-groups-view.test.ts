// @vitest-environment happy-dom
// Issue #906: the main menu's entries in nav groups, rendered inside the whole app against a fake of the daemon's HTTP
// surface. Every entry is in one group. A collapsed group hides its entries and shows their badges as one; open, each
// entry shows its own. The Dashboard and Needs you are pinned above the groups (issue #951). Which groups are collapsed is kept per browser and holds in the sidebar and the mobile drawer.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const job = (id: string) => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status: 'queued', approved: false, accepted: false,
  createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z', attempts: 0,
});

function fakeDaemon() {
  const waiting = [job('n1'), job('n2')];
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': {
      waiting, running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [],
      gate: { mode: 'review', autoAcceptPerHour: null }, presort: { sorter: 'oldest-first', jobIds: ['n1', 'n2'], reject: [] },
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

async function boot(collapsed?: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#dashboard';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  if (collapsed !== undefined) localStorage.setItem('jh_nav_collapsed', collapsed);
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
}

const group = (scope: string, id: string) => document.querySelector(`${scope} [data-nav-group="${id}"]`)!;
const toggle = (scope: string, id: string) => group(scope, id).querySelector('[data-slot="nav-group-toggle"]') as HTMLButtonElement;
const groupBadge = (scope: string, id: string) => group(scope, id).querySelector('[data-slot="nav-group-badge"]');
const queueLink = (scope: string) => document.querySelector(`${scope} a[href="#queue"]`);

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the nav groups', () => {
  it('put every view of the navigation in exactly one group, or pinned above them: only the Dashboard, which covers the whole system, and Needs you, whose badge already sums others\'', async () => {
    const nav = '../../ui/src/app/nav.tsx';
    const { VIEWS, NAV_GROUPS, NAV_PINNED } = (await import(nav)) as { VIEWS: readonly string[]; NAV_PINNED: readonly string[]; NAV_GROUPS: readonly { id: string; views: readonly string[] }[] };
    expect(NAV_PINNED).toEqual(['dashboard', 'needs-you']);
    const placed = [...NAV_PINNED, ...NAV_GROUPS.flatMap((g) => g.views)];
    expect([...placed].sort()).toEqual([...VIEWS].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('open by default: each entry shows its own badge and the group shows none', async () => {
    await boot();
    await vi.waitFor(() => expect(queueLink('aside')?.querySelector('[data-slot="nav-badge"]')?.textContent).toBe('2'));
    expect(toggle('aside', 'jobs').getAttribute('aria-expanded')).toBe('true');
    expect(groupBadge('aside', 'jobs')).toBeNull();
  });

  it('collapsed, a group hides its entries and shows their badges as one; opened again, each entry shows its own', async () => {
    await boot();
    await vi.waitFor(() => expect(queueLink('aside')?.querySelector('[data-slot="nav-badge"]')).not.toBeNull());
    await act(async () => toggle('aside', 'jobs').click());
    expect(toggle('aside', 'jobs').getAttribute('aria-expanded')).toBe('false');
    expect(queueLink('aside')).toBeNull();
    const badge = groupBadge('aside', 'jobs')!;
    expect(badge.textContent).toBe('2');
    expect(badge.getAttribute('title')).toBe('Queue: 2 jobs waiting to be ordered');
    expect(badge.className).toContain('bg-warn');
    expect(JSON.parse(localStorage.getItem('jh_nav_collapsed')!)).toEqual(['jobs']);
    await act(async () => toggle('aside', 'jobs').click());
    expect(queueLink('aside')?.querySelector('[data-slot="nav-badge"]')?.textContent).toBe('2');
    expect(groupBadge('aside', 'jobs')).toBeNull();
    expect(JSON.parse(localStorage.getItem('jh_nav_collapsed')!)).toEqual([]);
  });

  it('keeps which groups are collapsed: the next load starts with them collapsed', async () => {
    await boot('["jobs"]');
    await vi.waitFor(() => expect(groupBadge('aside', 'jobs')?.textContent).toBe('2'));
    expect(queueLink('aside')).toBeNull();
    expect(toggle('aside', 'waiting').getAttribute('aria-expanded')).toBe('true');
  });

  it('the mobile drawer shows the same groups, collapsed the same, with the same badges', async () => {
    await boot('["jobs"]');
    await vi.waitFor(() => expect(groupBadge('aside', 'jobs')?.textContent).toBe('2'));
    const open = document.querySelector('button[aria-label="Open navigation"]') as HTMLButtonElement;
    await act(async () => { open.click(); });
    const drawer = await vi.waitFor(() => { const d = document.querySelector('[role="dialog"]'); expect(d).not.toBeNull(); return '[role="dialog"]'; });
    expect(groupBadge(drawer, 'jobs')?.textContent).toBe('2');
    expect(queueLink(drawer)).toBeNull();
    await act(async () => toggle(drawer, 'jobs').click());
    expect(queueLink(drawer)?.querySelector('[data-slot="nav-badge"]')?.textContent).toBe('2');
    expect(queueLink('aside')).not.toBeNull();
  });
});
