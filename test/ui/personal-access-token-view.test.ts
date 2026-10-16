// @vitest-environment happy-dom
// Issue #1380 part 6: the GitHub account panel in Sources connects GitHub with a personal access token, with no GitHub App.
// The token goes to the hopper once, in the connect, and the field is cleared. A token connection lists the repositories
// the token reaches, not where the app is installed, and offers no app install link. The whole app against a fake of the
// daemon's HTTP surface.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, source, unmount } from './sources-daemon.ts';

afterEach(unmount);

const SOURCES = { sources: [source('github-account', 'github-account', 'ok', { login: 'octo-user', assignee: 'octo-user', label: 'hopper' })] };
const TOKEN_CONNECTED = {
  provider: 'github', via: 'the hopper\'s app', state: 'connected', account: 'octo-user', connectedAt: '2026-10-15T00:00:00.000Z', jobRepositories: [],
  grantedBy: 'token', connectedBy: 'sources', installations: [{ account: 'octo-user', repositorySelection: 'selected', repositories: ['octo-user/tools'] }],
  installationsCheckedAt: '2026-10-15T00:00:00.000Z',
};
const panel = () => document.querySelector('[data-connected-account="github"]');
const posts = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url) === '/ui/api/connected-accounts' && init?.method === 'POST')
  .map(([, init]) => JSON.parse(String(init!.body)) as unknown);

describe('Sources view: GitHub through a personal access token', () => {
  it('not connected: a token field connects with the token, and the field is cleared', async () => {
    await boot({ '/api/sources': SOURCES, '/ui/api/connected-accounts': TOKEN_CONNECTED });
    await vi.waitFor(() => expect(panel()?.querySelector('[data-token-connect]')).not.toBeNull());
    const input = panel()!.querySelector('[data-token-input]') as HTMLInputElement;
    expect(input.type).toBe('password');
    const button = panel()!.querySelector('[data-token-connect]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, ' github_pat_1 ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (panel()!.querySelector('[data-token-connect]') as HTMLButtonElement).click(); });
    expect(posts()).toEqual([{ action: 'connect-token', token: 'github_pat_1', provider: 'github' }]);
    await vi.waitFor(() => expect(panel()?.querySelector('[data-token-input]')).toBeNull());
  });

  it('a token connection lists the repositories the token reaches, with no app install link', async () => {
    await boot({ '/api/sources': SOURCES, '/api/connected-accounts': { accounts: [TOKEN_CONNECTED] } });
    await vi.waitFor(() => expect(panel()?.querySelector('[data-repository="octo-user/tools"]')).not.toBeNull());
    const text = panel()!.textContent ?? '';
    expect(text).toContain('Repositories the token reaches');
    expect(text).toContain('a personal access token');
    expect(text).not.toContain('Where the app is installed');
    expect(text).not.toContain('Add the app to another account');
  });
});
