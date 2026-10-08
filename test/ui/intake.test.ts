// @vitest-environment happy-dom
// Issue #440 in the UI, against a fake of the daemon's HTTP surface. Sources lists every open labelled issue
// its GitHub connection listed: taken, or the one reason it was not, with Assign to me (one, or all) and Release
// claim where the source offers them; what the intake migration changed, once; and the repos outside the job
// repositories with issues for the user, each with Add, which saves the job repositories with it. The Overview's
// idle lanes say why they are idle, from the latest Decision.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const url = (n: number, repo = 'octo-user/hopper') => `https://github.com/${repo}/issues/${n}`;
const DETAIL = {
  mode: 'account', login: 'octo-user', assignee: 'octo-user', label: 'hopper',
  intake: [
    { key: url(1), title: 'Taken one', repo: 'octo-user/hopper', jobId: 'j-1' },
    { key: url(2), title: 'Nobody has it', repo: 'octo-user/hopper', reason: 'not assigned to you', action: 'assign' },
    { key: url(3), title: 'Also unassigned', repo: 'octo-user/hopper', reason: 'not assigned to you', action: 'assign' },
    { key: url(4), title: 'Old claim', repo: 'octo-user/hopper', reason: 'claimed by another hopper', action: 'release' },
    { key: url(5), title: 'Kept out', repo: 'octo-user/hopper', reason: 'on the backburner' },
  ],
  intakeMigration: { at: '2026-10-08T10:00:00.000Z', changes: [{ key: url(6), change: 'released a claim with no holder recorded and no job in this hopper' }] },
  outsideRepos: [{ repo: 'octo-user/other', items: [url(1, 'octo-user/other')] }],
};
const SOURCES = [{ name: 'github-account', kind: 'github-account', state: 'ok', itemsSeen: 5, jobsCreated: 1, activeJobs: 1, detail: DETAIL }];
const ACCOUNTS = { accounts: [{
  provider: 'github', via: 'the hopper\'s app', state: 'connected', account: 'octo-user', jobRepositories: ['octo-user/hopper'],
  installations: [{ account: 'octo-user', repositorySelection: 'all', repositories: ['octo-user/hopper', 'octo-user/other'] }],
}] };
const MACHINES = { machines: [{ id: 'm1', label: 'm1', maxLanes: 2, online: true, executors: ['test'], usage: [], lanes: [
  { id: 'm1/lane-1', machineId: 'm1', state: 'idle', openedAt: '2026-10-08T09:00:00.000Z', idleSince: '2026-10-08T09:00:00.000Z' },
] }] };
const DECISION = {
  id: 'd1', at: '2026-10-08T10:00:00.000Z', trigger: 'tick', start: [], hold: [], wait: [], advice: [], reasons: [], inputs: {},
  lanes: [{ machineId: 'm1', current: 1, target: 0, open: 0, close: [], drain: [], reason: 'm1', idle: 'every waiting job is held: awaiting acceptance (2 jobs)' }],
};

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

const intake = () => document.querySelector<HTMLElement>('[data-intake="github-account"]');
const row = (key: string) => intake()!.querySelector<HTMLElement>(`[data-intake-item="${key}"]`)!;
const button = (el: ParentNode, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === text);
const click = async (b: HTMLButtonElement | undefined) => { await act(async () => { b!.click(); }); };

describe('Sources: what intake did with each labelled issue (issue #440)', () => {
  it('each issue is taken or says why, with the action the source offers', async () => {
    await boot('#sources');
    await vi.waitFor(() => expect(intake()).not.toBeNull());
    expect(intake()!.querySelector('[data-intake-summary]')?.textContent).toBe('5 open labelled issues: 1 taken, 4 not taken');
    expect(row(url(1)).textContent).toContain('taken');
    expect(row(url(2)).textContent).toContain('not assigned to you');
    expect(row(url(5)).textContent).toContain('on the backburner');
    expect(button(row(url(5)), 'Assign to me')).toBeUndefined();
    await click(button(row(url(2)), 'Assign to me'));
    await click(button(row(url(4)), 'Release claim'));
    await click(button(intake()!, 'Assign all 2 to me'));
    await vi.waitFor(() => expect(posts).toHaveLength(3));
    expect(posts).toEqual([
      { path: '/ui/api/sources/github-account/intake', body: { kind: 'assign', keys: [url(2)] } },
      { path: '/ui/api/sources/github-account/intake', body: { kind: 'release', keys: [url(4)] } },
      { path: '/ui/api/sources/github-account/intake', body: { kind: 'assign', keys: [url(2), url(3)] } },
    ]);
  });

  it('lists what the intake migration changed', async () => {
    await boot('#sources');
    await vi.waitFor(() => expect(intake()?.querySelector('[data-intake-migration]')).not.toBeNull());
    const m = intake()!.querySelector('[data-intake-migration]')!;
    expect(m.textContent).toContain('1 change');
    expect(m.textContent).toContain('released a claim with no holder recorded and no job in this hopper');
  });

  it('suggests repos outside the job repositories; Add saves them with it', async () => {
    await boot('#sources');
    await vi.waitFor(() => expect(document.querySelector('[data-outside-repo="octo-user/other"]')).not.toBeNull());
    const el = document.querySelector<HTMLElement>('[data-outside-repo="octo-user/other"]')!;
    expect(el.textContent).toContain('1 open issue for you');
    await click(button(el, 'Add to job repositories'));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ path: '/ui/api/connected-accounts', body: { provider: 'github', action: 'choose', repositories: ['octo-user/hopper', 'octo-user/other'] } });
  });
});

describe('Overview: why a lane is idle (issue #440)', () => {
  it('an idle lane and the room for one more say why, from the latest Decision', async () => {
    await boot('#overview');
    await vi.waitFor(() => expect(document.querySelectorAll('[data-lane-idle]')).toHaveLength(2));
    for (const el of document.querySelectorAll('[data-lane-idle]')) expect(el.textContent).toContain('every waiting job is held: awaiting acceptance (2 jobs)');
  });
});
