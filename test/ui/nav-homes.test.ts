// @vitest-environment happy-dom
// Issue #2374: one canonical home per workflow. Views that showed the same data merged into one nav entry with tabs, each
// tab a filter of that one workflow: Approvals (Access requests, Pending approvals), Failures (Failures with Stuck, Parked),
// Jobs (Jobs, Queue order), Ask hopper (Run a job, Ask a question), Activity (Events, Decisions), Machines (Machines,
// Accounts, Logins), Usage (Usage, Resources). Every old hash opens its new home; an entry's badge sums its tabs'. Search
// keeps its route, which the header's search box opens; Your reports and Version history are in the user menu.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const job = (id: string, extra: Record<string, unknown> = {}) => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status: 'queued', approved: false, accepted: false,
  createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z', attempts: 0, ...extra,
});

function fakeDaemon() {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': {
      waiting: [job('n1'), job('n2')], running: [], operatorLed: [], waitingAnswer: [], ended: [], locked: [],
      parked: [job('p1', { status: 'parked', parked: { at: '2026-10-03T10:00:00Z', from: 'running' } })],
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
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code', identity: 'local' }, signIn: { local: true, origin: location.origin, realms: [] } });
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

async function boot(hash: string, collapsed?: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = hash;
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

const current = () => document.querySelector('aside a[aria-current="page"]')?.getAttribute('href');
const currentTab = () => document.querySelector('[data-slot="page-tabs"] a[aria-current="page"]')?.getAttribute('href');
const entryBadge = (href: string) => document.querySelector(`aside a[href="${href}"] [data-slot="nav-badge"]`);
const tabBadge = (href: string) => document.querySelector(`[data-slot="page-tabs"] a[href="${href}"] [data-slot="tab-badge"]`);

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('the nav groups after the merge', () => {
  it('Dashboard and Needs you pinned; Waiting on you, Work, Fleet, Infra and Admin; no group of one; 21 entries at most', async () => {
    const nav = '../../ui/src/app/nav.tsx';
    const { NAV_GROUPS, NAV_PINNED } = (await import(nav)) as { NAV_PINNED: readonly string[]; NAV_GROUPS: readonly { id: string; label: string; views: readonly string[] }[] };
    expect(NAV_PINNED).toEqual(['dashboard', 'needs-you']);
    expect(NAV_GROUPS.map((g) => [g.id, g.label, g.views])).toEqual([
      ['waiting', 'Waiting on you', ['intake', 'questions', 'proposals', 'approvals', 'failures', 'tagged']],
      ['jobs', 'Work', ['jobs', 'pull-requests', 'research', 'ask', 'artifacts', 'activity']],
      ['sources-machines', 'Fleet', ['machines', 'usage', 'sources']],
      ['infra', 'Infra', ['infra', 'topology']],
      ['settings', 'Admin', ['skills', 'settings']],
    ]);
    for (const g of NAV_GROUPS) expect(g.views.length).toBeGreaterThan(1);
    expect(NAV_PINNED.length + NAV_GROUPS.reduce((t, g) => t + g.views.length, 0)).toBeLessThanOrEqual(21);
  });

  it('every tab of a merged page is reached by one hash: its home and the tab', async () => {
    const nav = '../../ui/src/app/nav.tsx';
    const { PAGE_TABS } = (await import(nav)) as { PAGE_TABS: Record<string, readonly { id: string; label: string }[]> };
    expect(Object.fromEntries(Object.entries(PAGE_TABS).map(([home, tabs]) => [home, tabs.map((t) => t.id)]))).toEqual({
      approvals: ['access-requests', 'pending-approvals'],
      failures: ['failures', 'parked'],
      jobs: ['jobs', 'queue'],
      ask: ['direct-jobs', 'direct-queries'],
      activity: ['events', 'decisions'],
      machines: ['machines', 'accounts', 'logins'],
      usage: ['usage', 'resources'],
    });
  });
});

describe('an old hash', () => {
  const MOVED: [string, string, string, string | undefined][] = [
    ['#resources', '#usage/resources', '#usage', '#usage/resources'],
    ['#access-requests', '#approvals/access-requests', '#approvals', '#approvals/access-requests'],
    ['#pending-approvals', '#approvals/pending-approvals', '#approvals', '#approvals/pending-approvals'],
    ['#stuck', '#failures', '#failures', '#failures/failures'],
    ['#parked', '#failures/parked', '#failures', '#failures/parked'],
    ['#events', '#activity/events', '#activity', '#activity/events'],
    ['#decisions', '#activity/decisions', '#activity', '#activity/decisions'],
    ['#accounts', '#machines/accounts', '#machines', '#machines/accounts'],
    ['#logins', '#machines/logins', '#machines', '#machines/logins'],
    ['#direct-jobs', '#ask/direct-jobs', '#ask', '#ask/direct-jobs'],
    ['#direct-queries', '#ask/direct-queries', '#ask', '#ask/direct-queries'],
    ['#queue', '#jobs/queue', '#jobs', '#jobs/queue'],
  ];
  for (const [old, to, entry, tab] of MOVED) {
    it(`${old} opens ${to}`, async () => {
      await boot(old);
      await vi.waitFor(() => expect(window.location.hash).toBe(to));
      expect(current()).toBe(entry);
      expect(currentTab()).toBe(tab);
    });
  }

  it('keeps what follows the view: #direct-queries/<id> opens #ask/direct-queries/<id>', async () => {
    await boot('#direct-queries/query-5f1c');
    await vi.waitFor(() => expect(window.location.hash).toBe('#ask/direct-queries/query-5f1c'));
    expect(currentTab()).toBe('#ask/direct-queries');
  });

  it('#search opens the Search page, which the header\'s search box opens, with no nav entry', async () => {
    await boot('#search');
    await vi.waitFor(() => expect(document.title).toBe('Search · hopper'));
    expect(document.querySelector('aside a[href="#search"]')).toBeNull();
    expect(window.location.hash).toBe('#search');
    // A phone has no search box in the header: the drawer lists Search.
    await act(async () => { (document.querySelector('button[aria-label="Open navigation"]') as HTMLButtonElement).click(); });
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"] a[href="#search"]')).not.toBeNull());
  });

  it('#reports opens Your reports, with no nav entry: the user menu links to it, and to Version history', async () => {
    await boot('#reports');
    await vi.waitFor(() => expect(document.title).toBe('Your reports · hopper'));
    expect(document.querySelector('aside a[href="#reports"]')).toBeNull();
    const trigger = document.querySelector<HTMLElement>('header [data-slot="user-menu-trigger"]')!;
    await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    const menu = await vi.waitFor(() => { const m = document.querySelector('[data-slot="user-menu"]'); expect(m).not.toBeNull(); return m!; });
    const links = [...menu.querySelectorAll('a[role="menuitem"]')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toContainEqual(['Your reports', '#reports']);
    expect(links).toContainEqual(['Version history', '#settings/version-history']);
  });
});

describe('the badges of a merged page', () => {
  it('an entry\'s badge sums its tabs\'; each tab shows its own', async () => {
    await boot('#jobs');
    await vi.waitFor(() => expect(entryBadge('#jobs')?.textContent).toBe('2'));
    expect(entryBadge('#jobs')!.getAttribute('title')).toBe('2 jobs waiting to be ordered');
    expect(tabBadge('#jobs/queue')?.textContent).toBe('2');
    expect(tabBadge('#jobs/jobs')).toBeNull();
    expect(entryBadge('#failures')?.textContent).toBe('1');
  });

  it('a collapsed group sums its entries\' badges, the merged ones too', async () => {
    await boot('#dashboard', '["jobs"]');
    const badge = await vi.waitFor(() => { const b = document.querySelector('aside [data-nav-group="jobs"] [data-slot="nav-group-badge"]'); expect(b?.textContent).toBe('2'); return b!; });
    expect(badge.getAttribute('title')).toBe('Jobs: 2 jobs waiting to be ordered');
  });

  it('on the Failures page, the Parked tab shows the parked jobs\' count', async () => {
    await boot('#failures');
    await vi.waitFor(() => expect(tabBadge('#failures/parked')?.textContent).toBe('1'));
  });
});
