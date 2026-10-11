// @vitest-environment happy-dom
// Issue #798 in the UI, against a fake of the daemon's HTTP surface. The issues a source did not take have their own view,
// Not taken, badged with the request cards waiting for approval: each source's issues grouped by why, with a count per
// group, no inner scroll box, Approve on a request card and Take off the backburner on a backburner issue. Sources groups
// its intake the same way. A taken issue whose job has ended says so, not "taken".
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const url = (n: number, repo = 'octo-user/hopper') => `https://github.com/${repo}/issues/${n}`;
const request = (n: number) => ({
  hash: String(n).repeat(64).slice(0, 64), title: `Request ${n}`, body: 'Please change it.', author: 'helper[bot]',
  actors: [{ role: 'author', login: 'helper[bot]', app: 'helper[bot]', trusted: false }, { role: 'labelled', login: 'octo-user', trusted: true }, { role: 'assigned', login: 'octo-user', trusted: true }],
  why: ['written by an app or a bot (helper[bot])'],
});
const DETAIL = {
  mode: 'account', login: 'octo-user', assignee: 'octo-user', label: 'hopper',
  intake: [
    { key: url(1), title: 'Taken one', repo: 'octo-user/hopper', jobId: 'j-1', jobStatus: 'running' },
    { key: url(2), title: 'Taken, job ended', repo: 'octo-user/hopper', jobId: 'j-2', jobStatus: 'done' },
    { key: url(3), title: 'Nobody has it', repo: 'octo-user/hopper', reason: 'not assigned to you', action: 'assign', group: 'not-assigned' },
    { key: url(4), title: 'Kept out', repo: 'octo-user/hopper', reason: 'on the backburner', action: 'unbackburner', group: 'backburner' },
    { key: url(5), title: 'Kept out too', repo: 'octo-user/hopper', reason: 'on the backburner', action: 'unbackburner', group: 'backburner' },
    { key: url(6), title: 'PR open', repo: 'octo-user/hopper', reason: 'done: its pull request waits for review', group: 'pr-waiting' },
    { key: url(7), title: 'Half', repo: 'octo-user/hopper', reason: 'partly done: the rest runs once its pull request merges', group: 'partly-done' },
    { key: url(8), title: 'Failed', repo: 'octo-user/hopper', reason: 'failed: hopper:failed is on the issue', group: 'other' },
    { key: url(9), title: 'Request 9', repo: 'octo-user/hopper', reason: 'a request: approve it to take it', action: 'approve', group: 'request', request: request(9) },
    { key: url(10), title: 'Request 10', repo: 'octo-user/hopper', reason: 'a request: approve it to take it', action: 'approve', group: 'request', request: request(1) },
  ],
};
const SOURCES = [{ name: 'github-account', kind: 'github-account', state: 'ok', itemsSeen: 10, jobsCreated: 2, activeJobs: 1, detail: DETAIL }];
const ACCOUNTS = { accounts: [] };
const MACHINES = { machines: [] };
const DECISION = { id: 'd1', at: '2026-10-08T10:00:00.000Z', trigger: 'tick', start: [], hold: [], wait: [], advice: [], reasons: [], inputs: {}, lanes: [] };

const posts: { path: string; body: unknown }[] = [];
function fakeDaemon() {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': MACHINES, '/api/decisions': { decisions: [DECISION] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: SOURCES },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/connected-accounts': ACCOUNTS,
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(String(init.body)) });
      return json(path === '/ui/api/connected-accounts' ? ACCOUNTS.accounts[0] : { done: [], failed: {} });
    }
    return path in routes ? json(routes[path]) : new Response('{"error":"not found"}', { status: 404 });
  });
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot(hash: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  posts.length = 0;
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

const view = () => document.querySelector<HTMLElement>('[data-not-taken="github-account"]');
const group = (el: ParentNode, g: string) => el.querySelector<HTMLElement>(`[data-intake-group="${g}"]`)!;
const row = (el: ParentNode, key: string) => el.querySelector<HTMLElement>(`[data-intake-item="${key}"]`)!;
const button = (el: ParentNode, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === text);
const click = async (b: HTMLButtonElement | undefined) => { await act(async () => { b!.click(); }); };
const navLink = (hash: string) => document.querySelector<HTMLElement>(`nav a[href="${hash}"]`)!;

describe('Not taken: the issues a source did not take, grouped by why (issue #798)', () => {
  it('the nav entry is badged with the request cards waiting for approval', async () => {
    await boot('#overview');
    await vi.waitFor(() => expect(navLink('#not-taken').querySelector('[data-slot="nav-badge"]')?.textContent).toBe('2'));
    expect(navLink('#not-taken').textContent).toContain('Not taken');
  });

  it('groups every issue not taken by why, with counts, requests first, and lists no taken one', async () => {
    await boot('#not-taken');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    const groups = [...view()!.querySelectorAll<HTMLElement>('[data-intake-group]')].map((g) => g.getAttribute('data-intake-group'));
    expect(groups).toEqual(['request', 'not-assigned', 'backburner', 'pr-waiting', 'partly-done', 'other']);
    const count = (g: string) => group(view()!, g).querySelector('[data-intake-group-count]')!.textContent;
    expect([count('request'), count('backburner'), count('pr-waiting')]).toEqual(['2', '2', '1']);
    expect(group(view()!, 'request').textContent).toContain('Needs approval');
    expect(row(view()!, url(1))).toBeNull();
    expect(view()!.querySelector('.overflow-y-auto')).toBeNull();
  });

  it('Approve on a request card and Take off the backburner act from the view', async () => {
    await boot('#not-taken');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    await click(button(row(view()!, url(9)), 'Approve'));
    await click(button(row(view()!, url(4)), 'Take off the backburner'));
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(posts).toEqual([
      { path: '/ui/api/sources/github-account/intake', body: { kind: 'approve', keys: [url(9)], hash: request(9).hash } },
      { path: '/ui/api/sources/github-account/intake', body: { kind: 'unbackburner', keys: [url(4)] } },
    ]);
  });
});

describe('Sources: intake grouped, no inner scroll box, a taken issue whose job ended (issue #798)', () => {
  it('groups the issues the same way, taken last, with no nested scroll region', async () => {
    await boot('#sources');
    const intake = () => document.querySelector<HTMLElement>('[data-intake="github-account"]');
    await vi.waitFor(() => expect(intake()).not.toBeNull());
    const groups = [...intake()!.querySelectorAll<HTMLElement>('[data-intake-group]')].map((g) => g.getAttribute('data-intake-group'));
    expect(groups).toEqual(['request', 'not-assigned', 'backburner', 'pr-waiting', 'partly-done', 'other', 'taken']);
    expect(intake()!.querySelector('.overflow-y-auto')).toBeNull();
    expect(row(intake()!, url(1)).textContent).toContain('taken');
    expect(row(intake()!, url(2)).textContent).toContain('its job ended: done');
    expect(row(intake()!, url(2)).querySelector('.text-ok')).toBeNull();
  });
});
