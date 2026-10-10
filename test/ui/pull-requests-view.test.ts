// @vitest-environment happy-dom
// The Pull requests view (issue #637), rendered inside the whole app against a fake of the daemon's HTTP surface: the
// header says how many repositories have yolo mode on and where merging waits; one group per repository, with its yolo
// badge and a switch an admin turns; each card with its state badge and its repository's yolo badge.
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitingLine, yoloLine } from '../../ui/src/model/pull-requests.ts';
import type { PullRequestCard, PullRequestsView } from '../../src/domain/types.ts';

const card = (over: Partial<PullRequestCard>): PullRequestCard => ({
  jobId: 'j1', repo: 'owner/a', issue: { number: 10, url: 'https://github.com/owner/a/issues/10' },
  pullRequest: { number: 11, url: 'https://github.com/owner/a/pull/11' }, part: false, state: 'open', checks: 'passing',
  mergeable: 'mergeable', draft: false, openedAt: '2026-10-08T10:00:00.000Z', yolo: false, waits: 'yolo off', ...over,
});

const fixture: PullRequestsView = {
  yolo: { on: 2, total: 3 },
  waiting: [{ repo: 'owner/a', count: 2, reason: 'yolo off' }, { repo: 'org/b', count: 1, reason: 'checks pending' }],
  repos: [
    { repo: 'owner/a', yolo: false, pullRequests: [card({}), card({ jobId: 'j2', part: true, pullRequest: undefined, openedAt: undefined, since: '2026-10-08T11:00:00.000Z' })] },
    { repo: 'org/b', yolo: true, pullRequests: [card({ jobId: 'j3', repo: 'org/b', yolo: true, checks: 'pending', waits: 'checks pending' })] },
    { repo: 'org/c', yolo: true, pullRequests: [card({ jobId: 'j4', repo: 'org/c', yolo: true, state: 'closed', waits: undefined, mergeable: 'conflicts', mergeError: 'Base branch was modified' })] },
  ],
};

function fakeDaemon(view: PullRequestsView, role: 'viewer' | 'admin') {
  const bodies: { path: string; body: unknown }[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], operatorLed: [], parked: [], waitingAnswer: [], ended: [], locked: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] }, '/api/sources': { sources: [] },
    '/api/questions': { questions: [] }, '/api/accounts': { accounts: [] },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] },
    '/api/pull-requests': view,
  };
  const fetch = vi.fn(async (input: string, init: RequestInit = {}) => {
    const [path] = String(input).split('?') as [string];
    if (path === '/ui/api/session') return json(200, { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role, realm: 'local', name: 'login code' }, signIn: { local: true, origin: location.origin, realms: [] } });
    if (path.startsWith('/ui/api/')) { bodies.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined }); return json(200, {}); }
    return json(200, routes[path] ?? {});
  });
  return { fetch, bodies };
}

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

let root: Root | undefined;

async function boot(view: PullRequestsView, role: 'viewer' | 'admin' = 'admin') {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#pull-requests';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  const daemon = fakeDaemon(view, role);
  vi.stubGlobal('fetch', daemon.fetch);
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.resetModules();
  const app = '../../ui/src/app/app.tsx'; // browser code, type-checked by ui/tsconfig.json: imported by path
  const { App } = (await import(app)) as { App: () => ReturnType<typeof createElement> };
  await act(async () => { root = createRoot(document.getElementById('root')!); root.render(createElement(App)); });
  await vi.waitFor(() => expect(document.querySelector('[data-slot="pr-yolo-line"]')).not.toBeNull());
  return daemon;
}

const text = (sel: string, el: ParentNode = document) => el.querySelector(sel)?.textContent ?? '';
const cardOf = (jobId: string) => document.querySelector(`[data-pull-request="${jobId}"]`)!;
const toggleOf = (repo: string) => document.querySelector<HTMLButtonElement>(`[data-repo="${repo}"] [role="switch"]`)!;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

describe('Pull requests view', () => {
  it('the nav has a Pull requests entry', async () => {
    await boot(fixture);
    expect(text('aside nav a[href="#pull-requests"]')).toBe('Pull requests');
  });

  it('the header says how many repos have yolo mode on and where merging waits', async () => {
    await boot(fixture);
    expect(text('[data-slot="pr-yolo-line"]')).toBe('yolo: on for 2 of 3 repos');
    expect(text('[data-slot="pr-waiting-line"]')).toBe('merging waits: 2 PRs in owner/a (yolo off), 1 PR in org/b (checks pending)');
    expect(waitingLine({ ...fixture, waiting: [] })).toBe('merging waits: nothing');
    expect(yoloLine(fixture)).toBe('yolo: on for 2 of 3 repos');
  });

  it('one group per repo, in order, each with its yolo badge and note', async () => {
    await boot(fixture);
    const groups = [...document.querySelectorAll('[data-repo]')];
    expect(groups.map((g) => g.getAttribute('data-repo'))).toEqual(['owner/a', 'org/b', 'org/c']);
    expect(groups[0]!.textContent).toContain('yolo off');
    expect(text('[data-slot="yolo-note"]', groups[0]!)).toContain('waits for a person');
    expect(text('[data-slot="yolo-note"]', groups[1]!)).toContain('merges a ready pull request');
  });

  it('each card shows its state badge, its yolo badge, the PR, the issue, checks and merge state', async () => {
    await boot(fixture);
    expect(text('[data-slot="pr-state"]', cardOf('j1'))).toBe('open');
    expect(text('[data-slot="pr-yolo"]', cardOf('j1'))).toBe('yolo off');
    expect(text('[data-slot="pr-state"]', cardOf('j3'))).toBe('open');
    expect(text('[data-slot="pr-yolo"]', cardOf('j3'))).toBe('yolo on');
    expect(text('[data-slot="pr-state"]', cardOf('j4'))).toBe('closed');
    expect(text('[data-slot="pr-yolo"]', cardOf('j4'))).toBe('yolo on');
    const pr = cardOf('j1').querySelector('a[href="https://github.com/owner/a/pull/11"]')!;
    expect(pr.textContent).toBe('#11');
    expect(cardOf('j1').querySelector('a[href="https://github.com/owner/a/issues/10"]')!.textContent).toBe('closes #10');
    expect(cardOf('j1').textContent).toContain('checks pass');
    expect(cardOf('j1').textContent).toContain('mergeable');
    expect(cardOf('j1').textContent).toContain('waits: yolo off');
    expect(cardOf('j2').textContent).toContain('pull request not named yet');
    expect(cardOf('j2').textContent).toContain('part of #10');
    expect(cardOf('j3').textContent).toContain('checks pending');
    expect(cardOf('j4').textContent).toContain('merge conflicts');
    expect(text('[data-slot="pr-merge-error"]', cardOf('j4'))).toContain('Base branch was modified');
  });

  it('an admin turns yolo mode on for one repo: the toggle posts that repo alone, then the list is read again', async () => {
    const daemon = await boot(fixture);
    const reads = () => daemon.fetch.mock.calls.filter(([p]) => String(p) === '/api/pull-requests').length;
    const before = reads();
    expect(toggleOf('owner/a').disabled).toBe(false);
    await act(async () => { toggleOf('owner/a').click(); });
    await vi.waitFor(() => expect(daemon.bodies).toEqual([{ path: '/ui/api/yolo-mode', body: { repos: { 'owner/a': true } } }]));
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(before));
    await act(async () => { toggleOf('org/b').click(); });
    await vi.waitFor(() => expect(daemon.bodies[1]).toEqual({ path: '/ui/api/yolo-mode', body: { repos: { 'org/b': false } } }));
  });

  it('a session that is not an admin sees the toggle, disabled', async () => {
    const daemon = await boot(fixture, 'viewer');
    expect(toggleOf('owner/a').disabled).toBe(true);
    await act(async () => { toggleOf('owner/a').click(); });
    expect(daemon.bodies).toEqual([]);
  });

  it('no card in any repo: the view says no pull request waits', async () => {
    await boot({ yolo: { on: 0, total: 1 }, waiting: [], repos: [{ repo: 'owner/a', yolo: false, pullRequests: [] }] });
    expect(text('[data-slot="pr-empty"]')).toBe('No pull request waits.');
    expect(text('[data-slot="pr-waiting-line"]')).toBe('merging waits: nothing');
  });
});
