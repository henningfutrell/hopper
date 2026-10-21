// @vitest-environment happy-dom
// Issue #201: the Queue view rendered in happy-dom inside the whole app against a fake of the daemon's
// HTTP surface. The Queue nav entry carries a badge while jobs wait on the pre-sort, and the Queue view
// names the queue sorter and links to where it is set up (#settings/routing). Issue #737: its job cards are collapsed by
// default — the issue, state, lane, pull request and the repository's yolo mode —, open one by one, or all at once. Issue
// #874: a held job's card says why it is held, collapsed too. Issue #1776: a job moves to any place in Your order, a
// button at an edge says why it moves nothing, a card says its boost and a place above a higher-priority job, and an
// order the daemon changed says why.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const job = (id: string, accepted: boolean, o: Record<string, unknown> = {}) => ({
  id, spec: { executor: 'test', payload: {}, goal: `goal ${id}` }, priority: 50, status: 'queued', approved: false, accepted,
  createdAt: '2026-10-03T10:00:00Z', updatedAt: '2026-10-03T10:00:00Z', attempts: 0, ...o,
});

/** What the fake daemon answers besides: more /api/queue fields, and the order's answer; `posts` keeps each order posted. */
interface Fake { queue?: Record<string, unknown>; adjusted?: { jobId: string; why: string }[]; posts?: unknown[] }

function fakeDaemon(waiting: ReturnType<typeof job>[], fake: Fake = {}) {
  const unaccepted = waiting.filter((j) => !j.accepted).map((j) => j.id);
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': {
      waiting, running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [],
      gate: { mode: 'review', autoAcceptPerHour: null }, presort: { sorter: 'oldest-first', jobIds: unaccepted, reject: [] }, ...fake.queue,
    },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/yolo-mode': { on: false, repos: { 'owner/a': true }, choices: { repos: ['owner/a', 'owner/b'] } },
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/queue/order') { fake.posts?.push(JSON.parse(String(init?.body))); return json(200, { jobs: [], adjusted: fake.adjusted ?? [] }); }
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

async function boot(waiting: ReturnType<typeof job>[], hash = '#queue', fake: Fake = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon(waiting, fake));
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
  it('the Queue nav entry counts the jobs waiting to be ordered', async () => {
    await boot([job('a1', true), job('n1', false), job('n2', false)]);
    await vi.waitFor(() => expect(queueLink().querySelector('[data-slot="nav-badge"]')?.textContent).toBe('2'));
    expect(queueLink().querySelector('[data-slot="nav-badge"]')!.getAttribute('title')).toBe('2 jobs waiting to be ordered');
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

describe('Your order: any place, and why when not (issue #1776)', () => {
  const card = (id: string) => document.querySelector(`[data-job-id="${id}"]`)!;
  const button = (id: string, label: string) => card(id).querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`)!;

  it('the second job moves up past a job of higher priority: the order posted puts it first', async () => {
    const posts: unknown[] = [];
    await boot([job('h', true, { priority: 75 }), job('a', true)], '#queue', { posts, queue: { effectivePriority: { h: 75, a: 50 } } });
    await vi.waitFor(() => expect(button('a', 'Move up')).toBeTruthy());
    expect(button('a', 'Move up').disabled).toBe(false);
    expect(button('h', 'Move down').disabled).toBe(false);
    await act(async () => button('a', 'Move up').click());
    await vi.waitFor(() => expect(posts).toEqual([{ jobIds: ['a', 'h'] }]));
  });

  it('a button at an edge is disabled and says why; a boost and a place above a higher-priority job show on the card', async () => {
    await boot([job('l', true, { priority: 25, userRank: 0 }), job('p', true, { pendingAnswer: 'yes', userRank: 1 })], '#queue',
      { queue: { effectivePriority: { l: 25, p: 70 } } });
    await vi.waitFor(() => expect(button('l', 'Move up')).toBeTruthy());
    expect([button('l', 'Move up').disabled, button('l', 'Move up').getAttribute('aria-label')]).toEqual([true, 'Move up: already first']);
    expect(button('l', 'Move up').closest('[data-slot="move-why"]')!.getAttribute('title')).toBe('Move up: already first');
    expect(button('p', 'Move down').getAttribute('aria-label')).toBe('Move down: already last');
    expect(card('l').querySelector('[data-slot="card-above-higher"]')!.textContent).toBe('placed by you above a higher-priority job');
    expect(card('p').querySelector('[data-slot="card-boost"]')!.textContent).toBe('boosted +20: resuming after an answer');
    expect(card('p').querySelector('[data-slot="card-above-higher"]')).toBeNull();
  });

  it('Accept at the top posts the job first; an order the daemon put lower says why, never "Queue ordered"', async () => {
    const posts: unknown[] = [];
    await boot([job('a', true), job('n', false)], '#queue', { posts, adjusted: [{ jobId: 'n', why: 'a job goes ahead of it: x (priority 90)' }] });
    const accept = await vi.waitFor(() => { const b = [...card('n').querySelectorAll('button')].find((x) => x.textContent === 'Accept at the top'); expect(b).toBeTruthy(); return b!; });
    await act(async () => accept.click());
    await vi.waitFor(() => expect(posts).toEqual([{ jobIds: ['n', 'a'] }]));
    await vi.waitFor(() => expect(document.body.textContent).toContain('Queue ordered, but n: a job goes ahead of it: x (priority 90)'));
  });
});
