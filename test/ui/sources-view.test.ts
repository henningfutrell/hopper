// @vitest-environment happy-dom
// The Sources view (issue #160) rendered in the whole app against a fake of the daemon's HTTP surface:
// the connected GitHub account is how the hopper reads GitHub as the user (issue #359), with an admin's
// GitHub App beside it in one GitHub section. The GitHub account is connected from there
// (issue #214): the panel says how the hopper connects, and shows the device code to enter. Signed in
// with GitHub, that connection is the one GitHub piece (issue #254). Once connected it shows the
// repositories the app reaches on each account it is installed on, and asks to install it only where it is
// installed nowhere (issue #253). Signed in with GitHub, that account is the sign-in: the panel offers
// Sign out, never Disconnect; signed in another way, forgetting it says it keeps the sign-in (issue #322).
// Of the repositories the app reaches the person chooses which ones jobs may use, filtering a long list,
// with a count of chosen against available (issue #321). A sign-in that expired says so and asks for a
// new one (issue #359), in the header too, on every screen (issue #441); a renewal that failed for a reason
// that may pass shows on the panel, and the connection reads as connected (issue #441). Signed in with GitHub, a
// connection that ended ended the session too: no reconnect, the page goes to sign-in at once (issue #513).
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GITHUB_SESSION, boot, source, unmount } from './sources-daemon.ts';

afterEach(unmount);

const titles = () => [...document.querySelectorAll('[aria-labelledby="sources-github"] h2')].map((h) => h.textContent);

describe('Sources view: GitHub', () => {
  it('one GitHub section: the GitHub account, then the App in use; no gh and no gh login (#359)', async () => {
    await boot();
    await vi.waitFor(() => expect(titles()).toEqual(['GitHub', 'GitHub account', 'github-app']));
    expect(document.querySelector('[data-github-summary]')?.textContent).toBe('Issues are read through the GitHub App, as its bot. Connect GitHub to read your own issues too.');
    const uses = [...document.querySelectorAll('[data-source-use]')].map((e) => [e.getAttribute('data-source-use'), e.textContent]);
    expect(uses).toEqual([['in-use', 'through the GitHub App, as its bot']]);
    expect(document.body.textContent).not.toContain('gh login');
    expect(document.body.textContent).not.toContain('Log in to GitHub');
  });

  it('a sign-in that expired says so, names the account, and asks to sign in again (#359)', async () => {
    const paused = "GitHub's sign-in expired: Sources → Connect GitHub again";
    await boot({
      '/api/sources': { sources: [source('github-account', 'github-account', 'disabled', { mode: 'account', paused, expired: true })] },
      '/api/connected-accounts': { accounts: [{ provider: 'github', via: 'the hopper\'s app', state: 'expired', account: 'octo-user', connectedAt: '2026-10-07T00:00:00.000Z', error: 'GitHub refused the refresh token (bad_refresh_token)' }] },
    });
    const panel = () => document.querySelector('[data-connected-account="github"]');
    await vi.waitFor(() => expect(panel()?.querySelector('[data-expired]')).not.toBeNull());
    expect(panel()!.textContent).toContain('Reconnect needed: GitHub refused the connection of octo-user');
    expect(document.body.textContent).toContain('reconnect needed');
    expect(document.querySelector('[data-github-summary]')?.textContent).toBe(`No issue is read through your GitHub connection: ${paused}.`);
    // The header says so on every screen, and leads to Sources (issue #441).
    const header = document.querySelector('header [data-connection-ended]') as HTMLAnchorElement | null;
    expect(header?.textContent).toBe('GitHub: reconnect needed');
    expect(header?.getAttribute('href')).toBe('#sources');
    const button = [...panel()!.querySelectorAll('button')].find((b) => b.textContent === 'Connect GitHub again')!;
    await act(async () => { button.click(); });
    await vi.waitFor(() => expect(panel()!.querySelector('[data-device-code]')?.textContent).toBe('WDJB-MJHT'));
  });

  it('signed in with GitHub, a connection that ended goes to sign-in at once: no reconnect offered (#513)', async () => {
    const paused = "GitHub's sign-in expired: Sources → Connect GitHub again";
    let reads = 0;
    // The daemon ended the session with the connection: the page's first read is from before.
    const signedOut = { authenticated: false, signIn: GITHUB_SESSION.signIn };
    await boot({
      '/ui/api/session': () => (++reads === 1 ? GITHUB_SESSION : signedOut),
      '/api/sources': { sources: [source('github-account', 'github-account', 'disabled', { mode: 'account', paused, expired: true })] },
      '/api/connected-accounts': { accounts: [{ provider: 'github', via: 'the hopper\'s app', state: 'expired', account: 'octo-user', connectedAt: '2026-10-07T00:00:00.000Z', error: 'GitHub refused the refresh token (bad_refresh_token)' }] },
    });
    await vi.waitFor(() => expect(reads).toBeGreaterThan(1));
    await vi.waitFor(() => expect(document.querySelector('header')).toBeNull());
    expect(document.querySelector('[data-connection-ended]')).toBeNull();
    expect(document.body.textContent).not.toContain('Connect GitHub again');
    expect(document.body.textContent).toContain('Sign in with GitHub');
    // Signed in again, the page it was on opens.
    expect(localStorage.getItem('jh_return')).toBe('#sources');
  });

  it('a connection sealed under another key says to give the key back: no connect offered, no ended banner (#514)', async () => {
    const error = 'GitHub: a stored token cannot be opened: it was altered, or sealed under another HOPPER_MASTER_KEY; give the hopper the key it was sealed under — as HOPPER_MASTER_KEY, or as HOPPER_MASTER_KEY_PREVIOUS beside a new one — and restart';
    await boot({
      '/api/sources': { sources: [source('github-account', 'github-account', 'disabled', { mode: 'account', paused: error })] },
      '/api/connected-accounts': { accounts: [{ provider: 'github', via: 'the hopper\'s app', state: 'unreadable', account: 'octo-user', connectedAt: '2026-10-07T00:00:00.000Z', error }] },
    });
    const panel = () => document.querySelector('[data-connected-account="github"]');
    await vi.waitFor(() => expect(panel()?.querySelector('[data-unreadable]')).not.toBeNull());
    expect(panel()!.querySelector('[data-unreadable]')!.textContent).toContain('HOPPER_MASTER_KEY_PREVIOUS');
    const labels = [...panel()!.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels.some((l) => /^Connect GitHub/.test(l ?? ''))).toBe(false);
    expect(labels).toContain('Forget this connection');
    expect(document.querySelector('header [data-connection-ended]')).toBeNull();
  });

  it('a renewal that failed shows on the panel; the connection reads as connected, and the header stays quiet (#441)', async () => {
    await boot({
      '/api/sources': { sources: [source('github-account', 'github-account', 'ok', { mode: 'account', login: 'octo-user', assignee: 'octo-user', label: 'hopper' })] },
      '/api/connected-accounts': { accounts: [{ provider: 'github', via: 'the hopper\'s app', state: 'connected', account: 'octo-user', connectedAt: '2026-10-07T00:00:00.000Z', jobRepositories: [], installations: [], renewal: 'GitHub: could not renew the token: connect ECONNREFUSED' }] },
    });
    const panel = () => document.querySelector('[data-connected-account="github"]');
    await vi.waitFor(() => expect(panel()?.querySelector('[data-renewal]')).not.toBeNull());
    expect(panel()!.querySelector('[data-renewal]')!.textContent).toContain('connect ECONNREFUSED');
    expect(panel()!.querySelector('[data-renewal]')!.textContent).toContain('tries again by itself');
    expect(document.querySelector('header [data-connection-ended]')).toBeNull();
  });

  // Issue #647: the owner sees when and how the connection was made, and how it renews.
  it('shows when and how the connection was made, its last and next renewal, and its last error (#647)', async () => {
    await boot({
      '/api/sources': { sources: [source('github-account', 'github-account', 'ok', { mode: 'account', login: 'octo-user', assignee: 'octo-user', label: 'hopper' })] },
      '/api/connected-accounts': { accounts: [{
        provider: 'github', via: 'the hopper\'s app', state: 'connected', account: 'octo-user', connectedAt: '2026-10-07T00:00:00.000Z', jobRepositories: [], installations: [],
        connectedBy: 'sign-in', grantedBy: 'web', renewedAt: '2026-10-07T07:00:00.000Z', nextRenewalAt: '2026-10-07T14:00:00.000Z',
        lastError: { at: '2026-10-07T06:59:00.000Z', error: 'GitHub: could not renew the token: http_502' },
      }] },
    });
    const health = () => document.querySelector('[data-connection-health]');
    await vi.waitFor(() => expect(health()).not.toBeNull());
    expect(health()!.querySelector('[data-connected-at]')!.textContent).toContain('by signing in with GitHub, through the browser');
    expect(health()!.querySelector('[data-renewed-at]')!.textContent).toBe(new Date('2026-10-07T07:00:00.000Z').toLocaleString());
    expect(health()!.querySelector('[data-next-renewal]')!.textContent).toBe(new Date('2026-10-07T14:00:00.000Z').toLocaleString());
    expect(health()!.querySelector('[data-last-error]')!.textContent).toContain('http_502');
  });

  it('a sign-in held while the connection works: Use this sign-in, or Keep this connection (#647)', async () => {
    const connected = { provider: 'github', via: 'the hopper\'s app', state: 'connected', account: 'octo-user', connectedAt: '2026-10-07T00:00:00.000Z', jobRepositories: [], installations: [] };
    await boot({
      '/api/sources': { sources: [source('github-account', 'github-account', 'ok', { mode: 'account', login: 'octo-user', assignee: 'octo-user', label: 'hopper' })] },
      '/api/connected-accounts': { accounts: [{ ...connected, held: { account: 'octo-user', at: '2026-10-09T18:50:00.000Z' } }] },
      '/ui/api/connected-accounts': connected,
    });
    const posts = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url) === '/ui/api/connected-accounts' && init?.method === 'POST').map(([, init]) => JSON.parse(String(init!.body)));
    const held = () => document.querySelector('[data-held]');
    await vi.waitFor(() => expect(held()).not.toBeNull());
    expect(held()!.textContent).toContain('did not replace this connection');
    const button = [...held()!.querySelectorAll('button')].find((b) => b.textContent === 'Use this sign-in')!;
    await act(async () => { button.click(); });
    await vi.waitFor(() => expect(posts()).toEqual([{ action: 'take-held', provider: 'github' }]));
    await vi.waitFor(() => expect(held()).toBeNull());
  });

  // Issue #518: a connection GitHub gave no refresh token ended after 8 hours with no word before it.
  it('a connection that cannot renew says so, and when it ends, while it still works; connecting again is offered (#518)', async () => {
    await boot({
      '/api/sources': { sources: [source('github-account', 'github-account', 'ok', { mode: 'account', login: 'octo-user', assignee: 'octo-user', label: 'hopper' })] },
      '/api/connected-accounts': { accounts: [{ provider: 'github', via: 'the hopper\'s app', state: 'connected', account: 'octo-user', connectedAt: '2026-10-07T00:00:00.000Z', jobRepositories: [], installations: [], expiresAt: '2026-10-07T08:00:00.000Z', unrenewable: 'GitHub gave this connection no refresh token' }] },
    });
    const panel = () => document.querySelector('[data-connected-account="github"]');
    await vi.waitFor(() => expect(panel()?.querySelector('[data-unrenewable]')).not.toBeNull());
    const text = panel()!.querySelector('[data-unrenewable]')!.textContent!;
    expect(text).toContain('GitHub gave this connection no refresh token');
    expect(text).toContain('It ends');
    expect([...panel()!.querySelectorAll('button')].map((b) => b.textContent)).toContain('Connect GitHub again');
    expect(panel()!.querySelector('[data-renewal]')).toBeNull();
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

  it('signed in with GitHub: the connection is the one GitHub piece, with its sync; no unset GitHub App (#254)', async () => {
    await boot({
      '/api/sources': { sources: [
        source('github-account', 'github-account', 'ok', { mode: 'account', login: 'octo-user', assignee: 'octo-user', label: 'hopper' }),
        source('github-app', 'github-app', 'ok', { mode: 'app', paused: 'no GitHub App configured' }),
      ] },
      '/api/connected-accounts': { accounts: [{ provider: 'github', via: 'the hopper\'s app', state: 'connected', account: 'octo-user', jobRepositories: ['octo-user/hopper'], installations: [{ account: 'octo-user', repositorySelection: 'all', repositories: ['octo-user/hopper'], settingsUrl: 'https://github.com/settings/installations/1' }] }] },
    });
    const panel = () => document.querySelector('[data-connected-account="github"]');
    await vi.waitFor(() => expect(panel()?.querySelector('[data-source-sync="github-account"]')).not.toBeNull());
    expect(titles()).toEqual(['GitHub', 'GitHub account']);
    expect(document.querySelector('[data-github-summary]')?.textContent).toBe('Issues are read, and jobs work, through your GitHub connection, octo-user.');
    expect(panel()!.textContent).toContain('Connected as octo-user.');
    expect(document.querySelectorAll('[data-source-use]')).toHaveLength(0);
    expect(document.body.textContent).not.toContain('github-app');
  });

  const connected = (installations?: unknown[]) => ({
    provider: 'github', via: 'the hopper\'s app', state: 'connected', account: 'octo-user', connectedAt: '2026-10-01T00:00:00.000Z', jobRepositories: [],
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
    expect([...installs[0]!.querySelectorAll('[data-repository] input[type="checkbox"]')]).toHaveLength(2);
    expect([...installs[1]!.querySelectorAll('[data-repository]')].map((e) => e.textContent)).toEqual(['octo-org/site']);
    expect(installs[1]!.textContent).toContain('chosen repositories');
    expect(links()).toEqual([
      ['Choose its repositories', 'https://github.com/settings/installations/1'],
      ['Choose its repositories', 'https://github.com/organizations/octo-org/settings/installations/2'],
      ['Add the app to another account or organization', 'https://github.com/apps/hopper-qm/installations/new'],
    ]);
    expect(panel()!.textContent).not.toMatch(/install the app/i);
  });

  it('installed: says what the app may do on each account, as GitHub granted it (#352)', async () => {
    await boot(withAccount(connected([
      { account: 'octo-org', repositorySelection: 'selected', repositories: ['octo-org/site'], settingsUrl: 'https://github.com/organizations/octo-org/settings/installations/2',
        permissions: { pull_requests: 'write', metadata: 'read', issues: 'write', contents: 'write' } },
    ])));
    await vi.waitFor(() => expect(panel()?.querySelector('[data-installation="octo-org"]')).not.toBeNull());
    expect(panel()!.querySelector('[data-installation="octo-org"] [data-installation-access]')?.textContent)
      .toBe('It may: read and write contents, issues, pull requests; read metadata.');
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
    expect(links()).toEqual([
      ['Choose its repositories', 'https://github.com/settings/installations/1'],
      ['Add the app to another account or organization', 'https://github.com/apps/hopper-qm/installations/new'],
    ]);
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

  describe('job repositories (#321)', () => {
    const three = [
      { account: 'octo-user', repositorySelection: 'all', repositories: ['octo-user/hopper', 'octo-user/tools'], settingsUrl: 'https://github.com/settings/installations/1' },
      { account: 'octo-org', repositorySelection: 'selected', repositories: ['octo-org/site'], settingsUrl: 'https://github.com/organizations/octo-org/settings/installations/2' },
    ];
    const summary = () => panel()!.querySelector('[data-job-repositories-summary]')?.textContent;
    const box = (repo: string) => panel()!.querySelector<HTMLInputElement>(`[data-repository="${repo}"] input[type="checkbox"]`)!;
    const shown = () => [...panel()!.querySelectorAll('[data-repository]')].filter((e) => !(e as HTMLElement).hidden).map((e) => e.getAttribute('data-repository'));
    const button = (text: string) => [...panel()!.querySelectorAll('button')].find((b) => b.textContent === text)!;
    const typeInto = async (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
    };

    it('none chosen: says no job comes in until some are, and counts chosen against available', async () => {
      await boot(withAccount({ ...connected(three), jobRepositories: [] }));
      await vi.waitFor(() => expect(summary()).toBe('0 of 3 repositories chosen for jobs'));
      expect(panel()!.querySelector('[data-job-repositories-none]')?.textContent).toContain('No new jobs come in until you choose');
      expect(['octo-user/hopper', 'octo-user/tools', 'octo-org/site'].map((r) => box(r).checked)).toEqual([false, false, false]);
    });

    it('filters the list, chooses repositories, and saves the choice without disconnecting', async () => {
      await boot({ ...withAccount({ ...connected(three), jobRepositories: ['octo-org/site'] }), '/ui/api/connected-accounts': { ...connected(three), jobRepositories: ['octo-user/tools'] } });
      await vi.waitFor(() => expect(summary()).toBe('1 of 3 repositories chosen for jobs'));
      expect(box('octo-org/site').checked).toBe(true);
      expect(button('Save').disabled).toBe(true);

      await typeInto(panel()!.querySelector<HTMLInputElement>('[data-repository-filter]')!, 'TOO');
      expect(shown()).toEqual(['octo-user/tools']);
      await act(async () => { button('Choose shown').click(); });
      await typeInto(panel()!.querySelector<HTMLInputElement>('[data-repository-filter]')!, '');
      expect(shown()).toEqual(['octo-user/hopper', 'octo-user/tools', 'octo-org/site']);
      expect(summary()).toBe('2 of 3 repositories chosen for jobs');
      await act(async () => { box('octo-org/site').click(); });
      expect(summary()).toBe('1 of 3 repositories chosen for jobs');

      const fetch = globalThis.fetch as ReturnType<typeof vi.fn>;
      await act(async () => { button('Save').click(); });
      const sent = fetch.mock.calls.filter(([url, init]) => String(url) === '/ui/api/connected-accounts' && (init as RequestInit | undefined)?.method === 'POST');
      expect(sent.map(([, init]) => JSON.parse(String((init as RequestInit).body)))).toEqual([{ action: 'choose', provider: 'github', repositories: ['octo-user/tools'] }]);
      await vi.waitFor(() => expect(summary()).toBe('1 of 3 repositories chosen for jobs'));
      expect(box('octo-user/tools').checked).toBe(true);
      expect(button('Save').disabled).toBe(true);
      expect(panel()!.textContent).toContain('Stop working through GitHub');
    });

    it('a chosen repository the app no longer reaches is shown, to be cleared', async () => {
      await boot(withAccount({ ...connected(three), jobRepositories: ['octo-user/gone'] }));
      await vi.waitFor(() => expect(summary()).toBe('1 of 3 repositories chosen for jobs'));
      const gone = panel()!.querySelector('[data-repository="octo-user/gone"]')!;
      expect(gone.textContent).toContain('the app does not reach it');
      expect(box('octo-user/gone').checked).toBe(true);
    });
  });
});
