// @vitest-environment happy-dom
// The Sources view (issue #160) rendered in the whole app against a fake of the daemon's HTTP surface:
// gh and the GitHub App are one GitHub section, the one in use first, the paused one saying why, and
// gh login beside them under its own name. The GitHub account is connected from there
// (issue #214): the panel says how the hopper connects, and shows the device code to enter. Signed in
// with GitHub, that connection is the one GitHub piece (issue #254). Once connected it shows the
// repositories the app reaches on each account it is installed on, and asks to install it only where it is
// installed nowhere (issue #253). Signed in with GitHub, that account is the sign-in: the panel offers
// Sign out, never Disconnect; signed in another way, forgetting it says it keeps the sign-in (issue #322).
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = (name: string, kind: string, state: string, detail: Record<string, unknown>) =>
  ({ name, kind, state, itemsSeen: 0, jobsCreated: 0, activeJobs: 0, detail });
const SOURCES = [
  source('github', 'github', 'disabled', { mode: 'gh', enabledSetting: 'auto', paused: 'GitHub App configured' }),
  source('github-app', 'github-app', 'ok', { mode: 'app', slug: 'hopper-app' }),
];

const LOGIN_CODE_SESSION = { authenticated: true, expiresAt: '2099-01-01T00:00:00.000Z', user: { role: 'admin', realm: 'local', name: 'login code' }, signIn: { local: true, origin: 'http://localhost', realms: [] } };
const GITHUB_SESSION = { ...LOGIN_CODE_SESSION, user: { role: 'admin', realm: 'github', name: 'octo-user', identity: 'octo-user' }, signIn: { ...LOGIN_CODE_SESSION.signIn, devices: [{ name: 'github', label: 'GitHub', type: 'github' }] } };

function fakeDaemon(over: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    '/api/health': { ok: true, version: '0', router: 'pass-through', fallback: false, executors: [], uptimeS: 1 },
    '/api/queue': { waiting: [], running: [], waitingAnswer: [], ended: [] },
    '/api/machines': { machines: [] }, '/api/decisions': { decisions: [] }, '/api/events': { events: [] },
    '/api/webhooks': { subscriptions: [] }, '/api/webhooks/deliveries': { deliveries: [] },
    '/api/questions': { questions: [] }, '/api/sources': { sources: SOURCES },
    '/api/usage': { readings: [], sources: [], limits: { soft: 0.7, hard: 0.95 }, machines: [] }, '/api/accounts': { accounts: [] },
    '/api/gh-login': { state: 'logged-in', account: 'someone' },
    '/api/connected-accounts': { accounts: [{ provider: 'github', via: 'the hopper\'s app', state: 'not-connected' }] },
    '/ui/api/connected-accounts': { provider: 'github', via: 'the hopper\'s app', state: 'waiting', userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: '2099-01-01T00:00:00.000Z' },
    ...over,
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  return vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).split('?')[0]!;
    // Connecting starts a device code: the daemon's GET answers it from then on.
    if (init?.method === 'POST' && path === '/ui/api/connected-accounts') {
      const accounts = (routes['/api/connected-accounts'] as { accounts: { provider: string }[] }).accounts;
      routes['/api/connected-accounts'] = { accounts: accounts.map((a) => (a.provider === 'github' ? routes[path] : a)) };
    }
    if (path === '/ui/api/session') return json(200, routes[path] ?? LOGIN_CODE_SESSION);
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

async function boot(over?: Record<string, unknown>) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '<div id="root"></div>';
  window.location.hash = '#sources';
  localStorage.clear();
  localStorage.setItem('jh_session', 'a'.repeat(64));
  vi.stubGlobal('fetch', fakeDaemon(over));
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

const titles = () => [...document.querySelectorAll('[aria-labelledby="sources-github"] h2')].map((h) => h.textContent);

describe('Sources view: GitHub', () => {
  it('one GitHub section: the App in use first, gh paused with the reason, gh login last', async () => {
    await boot();
    await vi.waitFor(() => expect(titles()).toEqual(['GitHub', 'GitHub account', 'github-app', 'github', 'gh login']));
    expect(document.querySelector('[data-github-summary]')?.textContent).toContain('Issues are read through the GitHub App, as its bot. gh is paused while the GitHub App is set up.');
    const uses = [...document.querySelectorAll('[data-source-use]')].map((e) => [e.getAttribute('data-source-use'), e.textContent]);
    expect(uses).toEqual([
      ['in-use', 'through the GitHub App, as its bot'],
      ['paused', 'through gh, as the logged-in GitHub user · not in use: the GitHub App is set up, so issues are read through it instead'],
    ]);
    expect(document.body.textContent).not.toContain('paused: GitHub App configured');
    expect(document.body.textContent).not.toContain('GitHub (gh)');
  });

  it('connects GitHub from the GitHub account panel: how the hopper connects, then the code to enter (#214)', async () => {
    await boot();
    const panel = () => document.querySelector('[data-connected-account="github"]');
    await vi.waitFor(() => expect(panel()?.textContent).toContain('Not connected.'));
    expect(panel()!.textContent).toContain('through the hopper\'s app');
    expect(panel()!.textContent).toContain('Signing in with GitHub connects it too');
    const button = [...panel()!.querySelectorAll('button')].find((b) => b.textContent === 'Connect GitHub')!;
    await act(async () => { button.click(); });
    await vi.waitFor(() => expect(panel()!.querySelector('[data-device-code]')?.textContent).toBe('WDJB-MJHT'));
    expect(document.querySelector('[aria-labelledby="sources-gitlab"]')).toBeNull();
  });

  it('signed in with GitHub: the connection is the one GitHub piece, with its sync; no gh, gh login or unset GitHub App (#254)', async () => {
    await boot({
      '/api/sources': { sources: [
        source('github-account', 'github-account', 'ok', { mode: 'account', login: 'octo-user', authors: ['octo-user'], label: 'hopper' }),
        source('github', 'github', 'disabled', { mode: 'gh', enabledSetting: 'auto', paused: 'GitHub account connected' }),
        source('github-app', 'github-app', 'ok', { mode: 'app', paused: 'no GitHub App configured' }),
      ] },
      '/api/gh-login': { state: 'logged-out' },
      '/api/connected-accounts': { accounts: [{ provider: 'github', via: 'the hopper\'s app', state: 'connected', account: 'octo-user', installations: [{ account: 'octo-user', repositorySelection: 'all', repositories: ['octo-user/hopper'], settingsUrl: 'https://github.com/settings/installations/1' }] }] },
    });
    const panel = () => document.querySelector('[data-connected-account="github"]');
    await vi.waitFor(() => expect(panel()?.querySelector('[data-source-sync="github-account"]')).not.toBeNull());
    expect(titles()).toEqual(['GitHub', 'GitHub account']);
    expect(document.querySelector('[data-github-summary]')?.textContent).toBe('Issues are read, and jobs work, through your GitHub connection, octo-user.');
    expect(panel()!.textContent).toContain('Connected as octo-user.');
    expect(document.querySelectorAll('[data-source-use]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('gh login');
    expect(document.body.textContent).not.toContain('gh is not logged in');
    expect(document.body.textContent).not.toContain('github-app');
  });

  const connected = (installations?: unknown[]) => ({
    provider: 'github', via: 'the hopper\'s app', state: 'connected', account: 'octo-user', connectedAt: '2026-10-01T00:00:00.000Z',
    installUrl: 'https://github.com/apps/hopper-qm/installations/new', configUrl: 'https://github.com/settings/installations',
    ...(installations ? { installations } : { installationsError: 'GitHub could not say where the app is installed: Service Unavailable' }),
  });
  const withAccount = (github: unknown) => ({ '/api/connected-accounts': { accounts: [github] } });
  const panel = () => document.querySelector('[data-connected-account="github"]');
  const links = () => [...panel()!.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);

  it('installed: the repositories it reaches on each account, a link to choose them, and no install nudge (#253)', async () => {
    await boot(withAccount(connected([
      { account: 'octo-user', repositorySelection: 'all', repositories: ['octo-user/hopper', 'octo-user/tools'], settingsUrl: 'https://github.com/settings/installations/1' },
      { account: 'octo-org', repositorySelection: 'selected', repositories: ['octo-org/site'], settingsUrl: 'https://github.com/organizations/octo-org/settings/installations/2' },
    ])));
    await vi.waitFor(() => expect(panel()?.textContent).toContain('Connected as octo-user.'));
    const installs = [...panel()!.querySelectorAll('[data-installation]')];
    expect(installs.map((e) => e.getAttribute('data-installation'))).toEqual(['octo-user', 'octo-org']);
    expect([...installs[0]!.querySelectorAll('[data-repository]')].map((e) => e.textContent)).toEqual(['octo-user/hopper', 'octo-user/tools']);
    expect(installs[0]!.textContent).toContain('all repositories');
    expect([...installs[1]!.querySelectorAll('[data-repository]')].map((e) => e.textContent)).toEqual(['octo-org/site']);
    expect(installs[1]!.textContent).toContain('chosen repositories');
    expect(links()).toEqual([
      ['Choose its repositories', 'https://github.com/settings/installations/1'],
      ['Choose its repositories', 'https://github.com/organizations/octo-org/settings/installations/2'],
    ]);
    expect(panel()!.textContent).not.toMatch(/install the app/i);
  });

  it('installed nowhere: says so, and links to install it (#253)', async () => {
    await boot(withAccount(connected([])));
    await vi.waitFor(() => expect(panel()?.textContent).toContain('Connected as octo-user.'));
    expect(panel()!.textContent).toContain('not installed');
    expect(links()).toEqual([['Install the app', 'https://github.com/apps/hopper-qm/installations/new']]);
  });

  it('an install that reaches no repository says so, with the link to choose them', async () => {
    await boot(withAccount(connected([{ account: 'octo-user', repositorySelection: 'selected', repositories: [], settingsUrl: 'https://github.com/settings/installations/1' }])));
    await vi.waitFor(() => expect(panel()?.querySelector('[data-installation="octo-user"]')?.textContent).toContain('no repository'));
    expect(links()).toEqual([['Choose its repositories', 'https://github.com/settings/installations/1']]);
  });

  it('GitHub could not say where it is installed: says why, links to see the installs, and never asks to install it (#263)', async () => {
    await boot(withAccount(connected()));
    await vi.waitFor(() => expect(panel()?.textContent).toContain('Connected as octo-user.'));
    expect(panel()!.querySelector('[data-installations-error]')?.textContent).toContain('GitHub could not say where the app is installed: Service Unavailable');
    expect(links()).toEqual([['See where the app is installed', 'https://github.com/settings/installations']]);
    expect(panel()!.textContent).not.toMatch(/install the app/i);
  });

  const posts = (f: ReturnType<typeof vi.fn>, path: string) => f.mock.calls.filter(([u, i]) => String(u) === path && (i as RequestInit | undefined)?.method === 'POST');
  const buttons = () => [...panel()!.querySelectorAll('button')].map((b) => b.textContent);

  it('signed in with GitHub: the account is the sign-in — Sign out, never Disconnect (#322)', async () => {
    await boot({ ...withAccount(connected([])), '/ui/api/session': GITHUB_SESSION });
    await vi.waitFor(() => expect(panel()?.textContent).toContain('Signed in with GitHub as octo-user.'));
    expect(panel()!.textContent).not.toContain('Connected as');
    expect(panel()!.textContent).not.toMatch(/disconnect/i);
    expect(panel()!.textContent).toContain('Settings → Plugins');
    expect(buttons()).toEqual(['Sign out']);
    const f = fetch as unknown as ReturnType<typeof vi.fn>;
    await act(async () => { [...panel()!.querySelectorAll('button')].find((b) => b.textContent === 'Sign out')!.click(); });
    await vi.waitFor(() => expect(posts(f, '/ui/api/logout')).toHaveLength(1));
    expect(posts(f, '/ui/api/connected-accounts')).toHaveLength(0);
  });

  it('signed in another way: forgetting the account is its own action, and the sign-in stays (#322)', async () => {
    await boot(withAccount(connected([])));
    await vi.waitFor(() => expect(panel()?.textContent).toContain('Connected as octo-user.'));
    expect(panel()!.textContent).not.toMatch(/disconnect/i);
    expect(buttons()).toEqual(['Stop working through GitHub']);
    const button = [...panel()!.querySelectorAll('button')].find((b) => b.textContent === 'Stop working through GitHub')!;
    expect(button.title).toContain('you stay signed in');
    const f = fetch as unknown as ReturnType<typeof vi.fn>;
    await act(async () => { button.click(); });
    await vi.waitFor(() => expect(posts(f, '/ui/api/connected-accounts')).toHaveLength(1));
    expect(JSON.parse(String((posts(f, '/ui/api/connected-accounts')[0]![1] as RequestInit).body))).toEqual({ action: 'disconnect', provider: 'github' });
    expect(posts(f, '/ui/api/logout')).toHaveLength(0);
  });
});
