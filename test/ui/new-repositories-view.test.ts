// @vitest-environment happy-dom
// Issue #2795: new repositories in Sources. Under a connected account's repositories, the new-repository policy: one mode for
// every owner, and one per owner the account reaches; and each new-repository ask, with Add to job repositories and Dismiss.
// The whole app against a fake of the daemon's HTTP surface.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, source, unmount } from './sources-daemon.ts';

afterEach(unmount);

const ACCOUNT = {
  provider: 'github', key: 'github', via: 'the hopper\'s app', state: 'connected', account: 'ada', connectedAt: '2026-10-16T00:00:00.000Z', jobRepositories: ['acme/api'],
  grantedBy: 'token', connectedBy: 'sources', installations: [{ account: 'acme', repositorySelection: 'all', repositories: ['acme/api', 'acme/web'] }, { account: 'octo', repositorySelection: 'all', repositories: ['octo/tools'] }],
  installationsCheckedAt: '2026-10-16T00:00:00.000Z',
  newRepositories: { policy: { mode: 'ask', owners: { octo: 'accept' } }, asks: [{ repository: 'acme/web', at: '2026-10-25T10:00:00.000Z' }] },
};
const SOURCES = { sources: [source('github-account', 'github-account', 'ok', { login: 'ada', assignee: 'ada', label: 'hopper' })] };
const box = () => document.querySelector('[data-new-repositories]');
const posts = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url) === '/ui/api/connected-accounts' && init?.method === 'POST')
  .map(([, init]) => JSON.parse(String(init!.body)) as unknown);
const pick = async (select: HTMLSelectElement, value: string) => act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); });

describe('Sources view: new repositories', () => {
  it('shows the policy and each ask; Add chooses it, Dismiss drops it', async () => {
    await boot({ '/api/sources': SOURCES, '/api/connected-accounts': { accounts: [ACCOUNT] }, '/ui/api/connected-accounts': ACCOUNT });
    await vi.waitFor(() => expect(box()).not.toBeNull());
    expect((box()!.querySelector('[data-new-repository-mode]') as HTMLSelectElement).value).toBe('ask');
    expect((box()!.querySelector('[data-new-repository-owner="octo"]') as HTMLSelectElement).value).toBe('accept');
    expect((box()!.querySelector('[data-new-repository-owner="acme"]') as HTMLSelectElement).value).toBe('');
    const ask = box()!.querySelector('[data-new-repository-ask="acme/web"]')!;
    expect(ask.textContent).toContain('acme/web');
    await act(async () => { (ask.querySelector('[data-new-repository-add]') as HTMLButtonElement).click(); });
    await act(async () => { (ask.querySelector('[data-new-repository-dismiss]') as HTMLButtonElement).click(); });
    expect(posts()).toEqual([
      { action: 'choose', provider: 'github', repositories: ['acme/api', 'acme/web'] },
      { action: 'new-repositories', provider: 'github', dismiss: ['acme/web'] },
    ]);
  });

  it('changing a mode sends the whole policy', async () => {
    await boot({ '/api/sources': SOURCES, '/api/connected-accounts': { accounts: [ACCOUNT] }, '/ui/api/connected-accounts': ACCOUNT });
    await vi.waitFor(() => expect(box()).not.toBeNull());
    await pick(box()!.querySelector('[data-new-repository-owner="acme"]') as HTMLSelectElement, 'accept');
    await pick(box()!.querySelector('[data-new-repository-owner="octo"]') as HTMLSelectElement, '');
    await pick(box()!.querySelector('[data-new-repository-mode]') as HTMLSelectElement, 'accept');
    expect(posts()).toEqual([
      { action: 'new-repositories', provider: 'github', policy: { mode: 'ask', owners: { octo: 'accept', acme: 'accept' } } },
      { action: 'new-repositories', provider: 'github', policy: { mode: 'ask', owners: {} } },
      { action: 'new-repositories', provider: 'github', policy: { mode: 'accept', owners: { octo: 'accept' } } },
    ]);
  });
});
