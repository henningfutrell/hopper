// @vitest-environment happy-dom
// Issue #798 in the UI, against a fake of the daemon's HTTP surface. The issues a source listed have their own view, Intake
// (issue #897; Not taken until then), badged with the request cards waiting for approval: each source's issues grouped by
// why, with a count per group, no inner scroll box, Approve on a request card and Take off the backburner on a
// backburner issue. Issue #1035: only the issues waiting on an intake decision; taken, partly done and pull-request-waits
// issues are job progress, on Jobs, and Intake counts them in one line that links there. Issue #808: the issues on the backburner are
// counted in the nav and from the Queue, and each says its number, since when and by whom it is on the backburner.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { countStates } from '../../src/domain/work-items.ts';
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
const SOURCES = [{ name: 'github-account', kind: 'github-account', state: 'ok', itemsSeen: 10, jobsCreated: 2, activeJobs: 1, detail: DETAIL }];
const ACCOUNTS = { accounts: [{
  provider: 'github', via: 'the hopper\'s app', state: 'connected', account: 'octo-user', jobRepositories: ['octo-user/hopper'],
  installations: [{ account: 'octo-user', repositorySelection: 'all', repositories: ['octo-user/hopper'] }],
}] };
const MACHINES = { machines: [] };
const DECISION = { id: 'd1', at: '2026-10-08T10:00:00.000Z', trigger: 'tick', start: [], hold: [], wait: [], advice: [], reasons: [], inputs: {}, lanes: [] };

const posts: { path: string; body: unknown }[] = [];
// What the daemon answers an intake action, and the sources it lists: a test can hold the answer and change the list.
let answer: (body: { keys: string[] }) => unknown = () => ({ done: [], failed: {} });
let sources: unknown[] = SOURCES;
function fakeDaemon() {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    // The work-item ledger's counts (issue #1067): 3 items wait for approval, though the source's last sync listed 2 cards.
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
      return json(path === '/ui/api/connected-accounts' ? ACCOUNTS.accounts[0] : await answer(body));
    }
    if (path === '/api/sources') return json({ sources });
    return path in routes ? json(routes[path]) : new Response('{"error":"not found"}', { status: 404 });
  });
}

// The live stream: a test sends a source.updated, as the daemon does when a sync ends.
const streamed = new Map<string, (m: { data: string }) => void>();
class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(type: string, f: (m: { data: string }) => void): void { streamed.set(type, f); }
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
  answer = () => ({ done: [], failed: {} });
  sources = SOURCES;
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

const view = () => document.querySelector<HTMLElement>('[data-intake="github-account"]');
const group = (el: ParentNode, g: string) => el.querySelector<HTMLElement>(`[data-intake-group="${g}"]`)!;
const row = (el: ParentNode, key: string) => el.querySelector<HTMLElement>(`[data-intake-item="${key}"]`)!;
const button = (el: ParentNode, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === text);
const click = async (b: HTMLButtonElement | undefined) => { await act(async () => { b!.click(); }); };
const navLink = (hash: string) => document.querySelector<HTMLElement>(`nav a[href="${hash}"]`)!;

describe('Intake: the issues a source listed, grouped by why (issues #798, #897)', () => {
  it('the nav entry is badged with the items the work-item ledger has waiting for approval (issue #1067), and so is Needs you\'s Intake row', async () => {
    await boot('#dashboard');
    await vi.waitFor(() => expect(navLink('#intake').querySelector('[data-slot="nav-badge"]')?.textContent).toBe('3'));
    expect(navLink('#intake').textContent).toContain('Intake');
  });

  it('groups the issues waiting on an intake decision by why, with counts, requests first', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    const groups = [...view()!.querySelectorAll<HTMLElement>('[data-intake-group]')].map((g) => g.getAttribute('data-intake-group'));
    expect(groups).toEqual(['request', 'not-assigned', 'backburner', 'other']);
    const count = (g: string) => group(view()!, g).querySelector('[data-intake-group-count]')!.textContent;
    expect([count('request'), count('backburner'), count('other')]).toEqual(['2', '2', '1']);
    expect(group(view()!, 'request').textContent).toContain('Needs approval');
    expect(view()!.querySelector('.overflow-y-auto')).toBeNull();
  });

  it('Approve on a request card and Take off the backburner act from the view', async () => {
    await boot('#intake');
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

describe('Intake leaves job progress to Jobs (issue #1035)', () => {
  it('lists no taken, partly done or pull-request-waits issue, and counts them in one line that links to Jobs', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    for (const n of [1, 2, 6, 7]) expect(row(view()!, url(n))).toBeNull();
    const link = view()!.querySelector<HTMLAnchorElement>('[data-intake-in-progress]')!;
    expect(link.getAttribute('href')).toBe('#jobs');
    expect(link.textContent).toBe('4 in progress on Jobs');
    expect(view()!.querySelector('[data-intake-summary]')!.textContent).toContain('6 waiting for intake');
  });

  it('with 4 taken issues, 1 partly done issue and 0 requests, it lists no issue and says nothing is waiting', async () => {
    const taken = (n: number) => ({ key: url(n), title: `Taken ${n}`, repo: 'octo-user/hopper', jobId: `j-${n}`, jobStatus: 'running' });
    const intake = [taken(1), taken(2), taken(3), taken(4),
      { key: url(5), title: 'Half', repo: 'octo-user/hopper', reason: 'partly done: the rest runs once its pull request merges', group: 'partly-done' }];
    await boot('#intake');
    await act(async () => { streamed.get('source.updated')!({ data: JSON.stringify({ ...SOURCES[0], detail: { ...DETAIL, intake } }) }); });
    await vi.waitFor(() => expect(view()!.querySelector('[data-intake-item]')).toBeNull());
    expect(view()!.querySelector('[data-intake-group]')).toBeNull();
    expect(view()!.textContent).toContain('Nothing waiting for intake');
    expect(view()!.querySelector<HTMLAnchorElement>('[data-intake-in-progress]')!.textContent).toBe('5 in progress on Jobs');
  });
});

describe('Decline on a request card (issue #1035)', () => {
  it('Decline sends the text as read, and the card says it was declined', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    await click(button(row(view()!, url(9)), 'Decline'));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts).toEqual([{ path: '/ui/api/sources/github-account/intake', body: { kind: 'decline', keys: [url(9)], hash: request(9).hash } }]);
    await vi.waitFor(() => expect(row(view()!, url(9)).querySelector('[data-slot="request-declined"]')).not.toBeNull());
    expect(button(row(view()!, url(9)), 'Approve')).toBeUndefined();
  });

  it('a declined request is no row: Intake counts it in one line', async () => {
    const declined = { key: url(11), title: 'No thanks', repo: 'octo-user/hopper', reason: 'a request you declined: an edit to its title or body shows it again', group: 'declined' };
    await boot('#intake');
    await act(async () => { streamed.get('source.updated')!({ data: JSON.stringify({ ...SOURCES[0], detail: { ...DETAIL, intake: [...DETAIL.intake, declined] } }) }); });
    await vi.waitFor(() => expect(view()!.querySelector('[data-intake-declined]')).not.toBeNull());
    expect(row(view()!, url(11))).toBeNull();
    expect(view()!.querySelector('[data-intake-group="declined"]')).toBeNull();
    expect(view()!.querySelector('[data-intake-declined]')!.textContent).toBe('1 request declined');
    expect(view()!.querySelector('[data-intake-summary]')!.textContent).toContain('6 waiting for intake');
  });
});

describe('the backburner is always visible (issue #808)', () => {
  it('the nav entry also counts the issues on the backburner, apart from the requests', async () => {
    await boot('#dashboard');
    await vi.waitFor(() => expect(navLink('#intake').querySelector('[data-slot="nav-badge-backburner"]')?.textContent).toBe('2'));
    expect(navLink('#intake').querySelector('[data-slot="nav-badge-backburner"]')!.getAttribute('title')).toBe('2 issues on the backburner');
    expect(navLink('#intake').querySelector('[data-slot="nav-badge"]')?.textContent).toBe('3');
  });

  it('each row says its issue number; a backburner row says since when and by whom, and looks unlike a taken one', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-10-11T09:00:00.000Z') });
    try {
      await boot('#intake');
      await vi.waitFor(() => expect(view()).not.toBeNull());
    } finally { vi.useRealTimers(); }
    expect(row(view()!, url(3)).textContent).toContain('#3');
    const parked = row(view()!, url(4));
    expect(parked.textContent).toContain('#4');
    expect(parked.querySelector('[data-backburner-since]')!.textContent).toBe('on the backburner 10d ago, by octo-user');
    expect(parked.getAttribute('data-backburner')).not.toBeNull();
    expect(row(view()!, url(5)).textContent).toContain('on the backburner');
    expect(row(view()!, url(5)).querySelector('[data-backburner-since]')).toBeNull();
  });

  it('the Queue links to the issues on the backburner, with their count', async () => {
    await boot('#queue');
    const link = () => document.querySelector<HTMLAnchorElement>('[data-slot="queue-backburner"]');
    await vi.waitFor(() => expect(link()).not.toBeNull());
    expect(link()!.getAttribute('href')).toBe('#intake');
    expect(link()!.textContent).toContain('2 issues on the backburner');
  });
});

describe('Approve on a request card: it shows at once, says how it ended, and keeps the place (issue #811)', () => {
  // The daemon's list after the approval: issue 9 is taken, as the sync the approval runs makes its job.
  const approved = () => [{ ...SOURCES[0], detail: { ...DETAIL, intake: DETAIL.intake.map((x) => (x.key === url(9)
    ? { key: url(9), title: 'Request 9', repo: 'octo-user/hopper', jobId: 'j-9', jobStatus: 'queued' } : x)) } }];
  const groupOf = (el: HTMLElement) => el.closest('[data-intake-group]')!.getAttribute('data-intake-group');

  it.each([
    ['Intake', '#intake', view],
  ])('%s: the button waits at once, sends once, and the approved issue stays where it was, with focus', async (_name, hash, list) => {
    await boot(hash);
    let release!: () => void;
    answer = (body) => new Promise((resolve) => { release = () => resolve({ done: body.keys, failed: {} }); });
    await vi.waitFor(() => expect(list()).not.toBeNull());
    const approve = button(row(list()!, url(9)), 'Approve')!;
    await click(approve);
    const waiting = row(list()!, url(9)).querySelector<HTMLButtonElement>('[data-slot="request-approve"]')!;
    expect(waiting.disabled).toBe(true);
    expect(waiting.getAttribute('aria-busy')).toBe('true');
    expect(waiting.textContent).toContain('Approving');
    await click(waiting);
    expect(posts).toHaveLength(1);

    // The sync the approval runs ends before the daemon answers: the stream brings the issue taken while Approve waits.
    await act(async () => { streamed.get('source.updated')!({ data: JSON.stringify(approved()[0]) }); });
    expect(groupOf(row(list()!, url(9)))).toBe('request');
    await act(async () => { release(); });
    await vi.waitFor(() => expect(row(list()!, url(9)).querySelector('[data-approved]')).not.toBeNull());
    const done = row(list()!, url(9));
    expect(groupOf(done)).toBe('request');
    expect(done.querySelector('[data-slot="request-card"]')).toBeNull();
    expect(done.textContent).toContain('taken');
    const requests = [...group(list()!, 'request').querySelectorAll<HTMLElement>('[data-intake-item]')].map((r) => r.getAttribute('data-intake-item'));
    expect(requests).toEqual([url(9), url(10)]);
    expect(group(list()!, 'request').querySelector('[data-intake-group-count]')!.textContent).toBe('1');
    expect(document.activeElement).toBe(done);
  });

  it.each([
    'already approved: its job is queued',
    'already taken, no approval needed: its job is running',
  ])('an approval answered "%s" (approved elsewhere since the page loaded) shows the issue approved, not an error (issue #1045)', async (why) => {
    await boot('#intake');
    answer = (body) => ({ done: [], failed: { [body.keys[0]!]: why } });
    await vi.waitFor(() => expect(view()).not.toBeNull());
    await click(button(row(view()!, url(9)), 'Approve'));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(row(view()!, url(9)).querySelector('[data-slot="request-error"]')).toBeNull();
    // The sync lists the issue taken, as the approval elsewhere made its job.
    await act(async () => { streamed.get('source.updated')!({ data: JSON.stringify(approved()[0]) }); });
    await vi.waitFor(() => expect(row(view()!, url(9)).querySelector('[data-approved]')).not.toBeNull());
  });

  it('a refused approval says why on the card, and the card stays with Approve', async () => {
    await boot('#intake');
    answer = (body) => ({ done: [], failed: { [body.keys[0]!]: 'its title or body changed since it was shown: read it again' } });
    await vi.waitFor(() => expect(view()).not.toBeNull());
    await click(button(row(view()!, url(9)), 'Approve'));
    await vi.waitFor(() => expect(row(view()!, url(9)).querySelector('[data-slot="request-error"]')).not.toBeNull());
    const card = row(view()!, url(9));
    expect(card.querySelector('[data-slot="request-error"]')!.textContent).toContain('its title or body changed since it was shown');
    expect(card.querySelector('[data-approved]')).toBeNull();
    expect(button(card, 'Approve')!.disabled).toBe(false);
  });
});
