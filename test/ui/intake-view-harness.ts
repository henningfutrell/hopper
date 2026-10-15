// Intake's view test harness (ui/src/views/intake.tsx): the whole app rendered in happy-dom against a fake of the daemon's
// HTTP surface, with one source's intake list and a live stream a test sends source.updated on. Shared by Intake's view
// test files; `unmount` after each test.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { countStates } from '../../src/domain/work-items.ts';
import { vi } from 'vitest';

export const url = (n: number, repo = 'octo-user/hopper') => `https://github.com/${repo}/issues/${n}`;
export const request = (n: number) => ({
  hash: String(n).repeat(64).slice(0, 64), title: `Request ${n}`, body: 'Please change it.', author: 'helper[bot]',
  actors: [{ role: 'author', login: 'helper[bot]', app: 'helper[bot]', trusted: false }, { role: 'labelled', login: 'octo-user', trusted: true }, { role: 'assigned', login: 'octo-user', trusted: true }],
  why: ['written by an app or a bot (helper[bot])'],
});
export const DETAIL = {
  mode: 'account', login: 'octo-user', assignee: 'octo-user', label: 'hopper',
  intake: [
    { key: url(1), title: 'Taken one', repo: 'octo-user/hopper', jobId: 'j-1', jobStatus: 'running' },
    { key: url(2), title: 'Taken, job ended', repo: 'octo-user/hopper', jobId: 'j-2', jobStatus: 'finished' },
    { key: url(3), title: 'Nobody has it', repo: 'octo-user/hopper', reason: 'not assigned to you', action: 'assign', group: 'not-assigned' },
    { key: url(4), title: 'Kept out', repo: 'octo-user/hopper', reason: 'on the backburner', action: 'unbackburner', group: 'backburner', backburner: { since: '2026-10-01T09:00:00.000Z', by: 'octo-user' } },
    { key: url(5), title: 'Kept out too', repo: 'octo-user/hopper', reason: 'on the backburner', action: 'unbackburner', group: 'backburner' },
    { key: url(6), title: 'PR open', repo: 'octo-user/hopper', reason: 'done: its pull request waits for review', group: 'pr-waiting' },
    { key: url(7), title: 'Half', repo: 'octo-user/hopper', reason: 'partly done: the rest runs once its pull request merges', group: 'partly-done' },
    { key: url(8), title: 'Failed', repo: 'octo-user/hopper', reason: 'failed: hopper:failed is on the issue', group: 'other' },
    { key: url(9), title: 'Request 9', repo: 'octo-user/hopper', reason: 'a request: approve it to take it', action: 'approve', group: 'request', request: request(9) },
    { key: url(10), title: 'Request 10', repo: 'octo-user/hopper', reason: 'a request: approve it to take it', action: 'approve', group: 'request', request: request(1) },
  ],
};
export const SOURCES = [{ name: 'github-account', kind: 'github-account', state: 'ok', itemsSeen: 10, jobsCreated: 2, activeJobs: 1, detail: DETAIL }];
const ACCOUNTS = { accounts: [{
  provider: 'github', via: 'the hopper\'s app', state: 'connected', account: 'octo-user', jobRepositories: ['octo-user/hopper'],
  installations: [{ account: 'octo-user', repositorySelection: 'all', repositories: ['octo-user/hopper'] }],
}] };
const MACHINES = { machines: [] };
const DECISION = { id: 'd1', at: '2026-10-08T10:00:00.000Z', trigger: 'tick', start: [], hold: [], wait: [], advice: [], reasons: [], inputs: {}, lanes: [] };

export const posts: { path: string; body: unknown }[] = [];
// What the daemon answers an intake action, and the sources it lists: a test can hold the answer and change the list.
export const daemon: { answer: (body: { keys: string[] }) => unknown; sources: unknown[] } = { answer: () => ({ done: [], failed: {} }), sources: SOURCES };
function fakeDaemon() {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    // The work-item ledger's counts (issue #1067): 3 items wait for approval, though the source's last sync listed 2 cards.
    // The badge counts the cards the page shows (issue #1193), not the ledger.
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [], items: { ...countStates([]), waiting_for_approval: 3 } },
    '/api/machines': MACHINES, '/api/decisions': { decisions: [DECISION] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/connected-accounts': ACCOUNTS,
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    if (path === '/ui/api/session') return json({ authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { keys: string[] };
      posts.push({ path, body });
      return json(path === '/ui/api/connected-accounts' ? ACCOUNTS.accounts[0] : await daemon.answer(body));
    }
    if (path === '/api/sources') return json({ sources: daemon.sources });
    return path in routes ? json(routes[path]) : new Response('{"error":"not found"}', { status: 404 });
  });
}

// The live stream: a test sends a source.updated, as the daemon does when a sync ends.
export const streamed = new Map<string, (m: { data: string }) => void>();
class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(type: string, f: (m: { data: string }) => void): void { streamed.set(type, f); }
  close(): void {}
}

let root: Root | undefined;

export async function boot(hash: string) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = hash;
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  posts.length = 0;
  daemon.answer = () => ({ done: [], failed: {} });
  daemon.sources = SOURCES;
  vi.stubGlobal('fetch', fakeDaemon());
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
}

export async function unmount(): Promise<void> {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
}

export const view = () => document.querySelector<HTMLElement>('[data-intake="github-account"]');
export const group = (el: ParentNode, g: string) => el.querySelector<HTMLElement>(`[data-intake-group="${g}"]`)!;
export const row = (el: ParentNode, key: string) => el.querySelector<HTMLElement>(`[data-intake-item="${key}"]`)!;
export const button = (el: ParentNode, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === text);
export const click = async (b: HTMLButtonElement | undefined) => { await act(async () => { b!.click(); }); };
export const navLink = (hash: string) => document.querySelector<HTMLElement>(`nav a[href="${hash}"]`)!;
