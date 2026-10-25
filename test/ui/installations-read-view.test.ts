// @vitest-environment happy-dom
// Issue #1250 part 2: the GitHub account panel in Sources shows where the hopper's app is installed as the hopper last read
// it, with when, and never asks GitHub on a load. Refresh asks the hopper to read it again; a read that failed says why,
// above the installations read before it. The whole app against a fake of the daemon's HTTP surface.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, source, unmount } from './sources-daemon.ts';

afterEach(unmount);

const SOURCES = { sources: [source('github-account', 'github-account', 'ok', { login: 'octo-user', assignee: 'octo-user', label: 'hopper' })] };
const CONNECTED = { provider: 'github', key: 'github', via: 'the hopper\'s app', state: 'connected', account: 'octo-user', connectedAt: '2026-10-07T00:00:00.000Z', jobRepositories: [] };
const INSTALLED = [{ account: 'octo-user', repositorySelection: 'all', repositories: ['octo-user/tools'] }];
const panel = () => document.querySelector('[data-connected-account="github"]');
const refreshes = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url) === '/ui/api/connected-accounts/refresh' && init?.method === 'POST')
  .map(([, init]) => JSON.parse(String(init!.body)) as unknown);

describe('Sources view: where the app is installed, from the hopper\'s database', () => {
  it('never read: says so, and Refresh asks the hopper to read it', async () => {
    await boot({ '/api/sources': SOURCES, '/api/connected-accounts': { accounts: [CONNECTED] }, '/ui/api/connected-accounts/refresh': { ...CONNECTED, installationsReading: true } });
    await vi.waitFor(() => expect(panel()?.querySelector('[data-installations-read]')?.textContent).toBe('not read yet'));
    expect(panel()!.querySelector('[data-installations-unread]')).not.toBeNull();
    expect(panel()!.querySelector('[data-installations-error]')).toBeNull();
    expect(refreshes()).toEqual([]);
    await act(async () => { (panel()!.querySelector('[data-installations-refresh]') as HTMLButtonElement).click(); });
    expect(refreshes()).toEqual([{ provider: 'github' }]);
  });

  it('read: says when; a failed read after it says why, above what was read before', async () => {
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    await boot({ '/api/sources': SOURCES, '/api/connected-accounts': { accounts: [{
      ...CONNECTED, installations: INSTALLED, installationsCheckedAt: at, installationsError: 'GitHub could not say where the app is installed: GitHub answered 503',
    }] } });
    await vi.waitFor(() => expect(panel()?.querySelector('[data-installations-read]')?.textContent).toBe('read 5m ago'));
    expect(panel()!.querySelector('[data-installations-error]')!.textContent).toContain('GitHub answered 503');
    expect(panel()!.querySelector('[data-installation="octo-user"]')).not.toBeNull();
  });
});
