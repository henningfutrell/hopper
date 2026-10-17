// @vitest-environment happy-dom
// Issue #201: the Queue view rendered in happy-dom inside the whole app against a fake of the daemon's
// HTTP surface. The Queue nav entry carries a badge while jobs wait on the pre-sort, and the Queue view
// names the queue sorter and links to where it is set up (#settings/routing). Issue #737: its job cards are collapsed by
// default — the issue, state, lane, pull request and the repository's yolo mode —, open one by one, or all at once. Issue
// #874: a held job's card says why it is held, collapsed too.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const job = (id: string, accepted: boolean, o: Record<string, unknown> = {}) => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status: 'queued', approved: false, accepted,
  createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z', attempts: 0, ...o,
});

function fakeDaemon(waiting: ReturnType<typeof job>[]) {
  const unaccepted = waiting.filter((j) => !j.accepted).map((j) => j.id);
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': {
      waiting, running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [],
      gate: { mode: 'review', autoAcceptPerHour: null }, presort: { sorter: 'oldest-first', jobIds: unaccepted, reject: [] },
    },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/yolo-mode': { on: false, repos: { 'owner/a': true }, choices: { repos: ['owner/a', 'owner/b'] } },
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

async function boot(waiting: ReturnType<typeof job>[], hash = '#queue') {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon(waiting));
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
}

const queueLink = () => document.querySelector('aside nav a[href="#queue"]')!;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Queue badge', () => {
  it('the Queue nav entry counts the jobs waiting on the pre-sort', async () => {
    await boot([job('a1', true), job('n1', false), job('n2', false)]);
    await vi.waitFor(() => expect(queueLink().querySelector('[data-slot="nav-badge"]')?.textContent).toBe('2'));
    expect(queueLink().querySelector('[data-slot="nav-badge"]')!.getAttribute('title')).toBe('2 jobs wait on the pre-sort');
  });

  it('no badge when every waiting job is accepted', async () => {
    await boot([job('a1', true)]);
    await vi.waitFor(() => expect(document.body.textContent).toContain('goal a1'));
    expect(queueLink().querySelector('[data-slot="nav-badge"]')).toBeNull();
  });
});

describe('Where the sorter is set up', () => {
  it('the Queue view names the queue sorter and links to the routing settings', async () => {
    await boot([job('n1', false)]);
    const link = await vi.waitFor(() => { const a = document.querySelector('a[data-slot="queue-sorter-link"]'); expect(a).not.toBeNull(); return a!; });
    expect(link.getAttribute('href')).toBe('#settings/routing');
    expect(link.textContent).toContain('Set up the sorter');
    expect(document.querySelector('[data-slot="queue-sorter"]')!.textContent).toContain('oldest-first');
  });
});

describe('Collapsed job cards (issue #737)', () => {
  const fromIssue = (id: string, repo: string, n: number, o: Record<string, unknown> = {}) =>
    job(id, true, { source: { source: 'gh', key: `${repo}#${n}`, repo, number: n, url: `https://github.com/${repo}/issues/${n}` }, ...o });
  const card = (id: string) => document.querySelector(`[data-job-id="${id}"]`)!;
  const toggleAll = () => document.querySelector<HTMLButtonElement>('[data-slot="cards-toggle-all"]')!;

  it('each card starts collapsed and shows the essentials: issue, state, lane, yolo mode of its repository', async () => {
    await boot([fromIssue('a1', 'owner/a', 7, { laneId: 'desk/lane-2' }), fromIssue('b1', 'owner/b', 9)]);
    await vi.waitFor(() => expect(card('a1').querySelector('[data-slot="card-yolo"]')?.textContent).toBe('yolo on'));
    expect(card('a1').getAttribute('data-expanded')).toBe('false');
    expect(card('a1').textContent).toContain('goal a1');
    expect(card('a1').textContent).toContain('a#7');
    expect(card('a1').querySelector('[data-slot="card-state"]')!.textContent).toBe('queued');
    expect(card('a1').querySelector('[data-slot="card-lane"]')!.textContent).toBe('desk · lane-2');
    expect(card('b1').querySelector('[data-slot="card-lane"]')!.textContent).toBe('no lane yet');
    expect(card('b1').querySelector('[data-slot="card-yolo"]')!.textContent).toBe('yolo off');
    expect(card('a1').textContent).not.toContain('prio 50');
  });

  it('a click opens one card for its detail; the others stay collapsed', async () => {
    await boot([job('a1', true), job('a2', true)]);
    const toggle = await vi.waitFor(() => { const b = card('a1')?.querySelector<HTMLButtonElement>('[data-slot="card-toggle"]'); expect(b).toBeTruthy(); return b!; });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle.click());
    expect(card('a1').getAttribute('data-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(card('a1').textContent).toContain('prio 50');
    expect(card('a2').getAttribute('data-expanded')).toBe('false');
    await act(async () => toggle.click());
    expect(card('a1').getAttribute('data-expanded')).toBe('false');
  });

  it('Expand all opens every card, in both columns; Collapse all closes them again', async () => {
    await boot([job('a1', true), job('n1', false)]);
    await vi.waitFor(() => expect(toggleAll()?.textContent).toContain('Expand all'));
    await act(async () => toggleAll().click());
    expect(['a1', 'n1'].map((id) => card(id).getAttribute('data-expanded'))).toEqual(['true', 'true']);
    expect(toggleAll().textContent).toContain('Collapse all');
    await act(async () => toggleAll().click());
    expect(['a1', 'n1'].map((id) => card(id).getAttribute('data-expanded'))).toEqual(['false', 'false']);
  });
});

describe('A held job says why (issue #874)', () => {
  const card = (id: string) => document.querySelector(`[data-job-id="${id}"]`)!;

  it('a held card shows its hold reason while it is collapsed; a queued card shows none', async () => {
    await boot([job('h1', false, { status: 'held', holdReason: 'awaiting acceptance' }), job('a1', true)]);
    const reason = await vi.waitFor(() => { const r = card('h1')?.querySelector('[data-slot="card-hold-reason"]'); expect(r).toBeTruthy(); return r!; });
    expect(card('h1').getAttribute('data-expanded')).toBe('false');
    expect(reason.textContent).toBe('awaiting acceptance');
    expect(card('a1').querySelector('[data-slot="card-hold-reason"]')).toBeNull();
  });

  it('the job view of a held job says why it is held', async () => {
    await boot([job('h1', true, { status: 'held', holdReason: 'no machine runs executor test' })], '#job/h1');
    const reason = await vi.waitFor(() => { const r = document.querySelector('[data-slot="job-hold-reason"]'); expect(r).toBeTruthy(); return r!; });
    expect(reason.textContent).toBe('no machine runs executor test');
  });

  it('the job view of a job that is not held shows no hold reason', async () => {
    await boot([job('a1', true)], '#job/a1');
    await vi.waitFor(() => expect(document.querySelector('[data-slot="job-view"]')?.textContent).toContain('goal a1'));
    expect(document.querySelector('[data-slot="job-hold-reason"]')).toBeNull();
  });
});
