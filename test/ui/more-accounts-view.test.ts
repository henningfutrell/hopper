// @vitest-environment happy-dom
// Issue #1448: more than one GitHub account. Under the connected first account, Add another GitHub account takes a personal
// access token of another account; the new account gets a panel of its own, with its job repositories and its source's sync,
// and Remove this account. A refusal says why. The job page names the account of the job's repository before it acted.
// The whole app against a fake of the daemon's HTTP surface.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, source, unmount } from './sources-daemon.ts';

afterEach(unmount);

const FIRST = {
  provider: 'github', key: 'github', via: 'the hopper\'s app', state: 'connected', account: 'ada-home', connectedAt: '2026-10-16T00:00:00.000Z', jobRepositories: ['ada-home/tools'],
  grantedBy: 'token', connectedBy: 'sources', installations: [{ account: 'ada-home', repositorySelection: 'selected', repositories: ['ada-home/tools'] }], installationsCheckedAt: '2026-10-16T00:00:00.000Z',
};
const WORK = {
  ...FIRST, key: 'github-2', account: 'ada-work', jobRepositories: ['acme/api'],
  installations: [{ account: 'acme', repositorySelection: 'selected', repositories: ['acme/api', 'acme/web'] }],
};
const SOURCES = { sources: [
  source('github-account', 'github-account', 'ok', { login: 'ada-home', assignee: 'ada-home', label: 'hopper' }),
  source('github-account-2', 'github-account', 'ok', { login: 'ada-work', assignee: 'ada-work', label: 'hopper', accountKey: 'github-2' }),
] };
const panel = (key: string) => document.querySelector(`[data-connected-account="${key}"]`);
const posts = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url) === '/ui/api/connected-accounts' && init?.method === 'POST')
  .map(([, init]) => JSON.parse(String(init!.body)) as unknown);
const type = async (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

describe('Sources view: more than one GitHub account', () => {
  it('adds another account with a token; it gets a panel of its own', async () => {
    await boot({ '/api/sources': SOURCES, '/api/connected-accounts': { accounts: [FIRST] }, '/ui/api/connected-accounts': WORK });
    await vi.waitFor(() => expect(panel('github')?.querySelector('[data-add-account]')).not.toBeNull());
    expect(panel('github-2')).toBeNull();
    const add = panel('github')!.querySelector('[data-add-account]')!;
    expect(add.textContent).toContain('Add another GitHub account');
    await type(add.querySelector('[data-token-input]') as HTMLInputElement, 'github_pat_work');
    await act(async () => { (add.querySelector('[data-token-connect]') as HTMLButtonElement).click(); });
    expect(posts()).toEqual([{ action: 'add-token', provider: 'github', token: 'github_pat_work' }]);
    await vi.waitFor(() => expect(panel('github-2')).not.toBeNull());
    const work = panel('github-2')!;
    expect(work.textContent).toContain('Connected as ada-work.');
    expect(work.querySelector('[data-repository="acme/web"]')).not.toBeNull();
    expect(work.querySelector('[data-add-account]')).toBeNull();
    expect(document.body.textContent).toContain('GitHub account 2');
  });

  it('a refused add says why, and adds no panel', async () => {
    await boot({ '/api/sources': SOURCES, '/api/connected-accounts': { accounts: [FIRST] }, '/ui/api/connected-accounts': { provider: 'github', key: 'github-2', via: 'the hopper\'s app', state: 'failed', error: 'GitHub account ada-home is connected already (github)' } });
    await vi.waitFor(() => expect(panel('github')?.querySelector('[data-add-account]')).not.toBeNull());
    const add = panel('github')!.querySelector('[data-add-account]')!;
    await type(add.querySelector('[data-token-input]') as HTMLInputElement, 'github_pat_home');
    await act(async () => { (add.querySelector('[data-token-connect]') as HTMLButtonElement).click(); });
    await vi.waitFor(() => expect(add.querySelector('[data-add-account-error]')?.textContent).toContain('connected already'));
    expect(panel('github-2')).toBeNull();
  });

  it('a further account shows its own source and choices, and sends its key; Remove this account forgets it', async () => {
    await boot({ '/api/sources': SOURCES, '/api/connected-accounts': { accounts: [FIRST, WORK] }, '/ui/api/connected-accounts': { ...WORK, jobRepositories: ['acme/api', 'acme/web'] } });
    await vi.waitFor(() => expect(panel('github-2')?.querySelector('[data-source-sync]') ?? panel('github-2')?.querySelector('[data-repository="acme/web"]')).not.toBeNull());
    const work = panel('github-2')!;
    expect(work.textContent).not.toContain('Sign out');
    expect(work.textContent).not.toContain('device code');
    const web = work.querySelector('[data-repository="acme/web"] input') as HTMLInputElement;
    await act(async () => { web.click(); });
    await act(async () => { [...work.querySelectorAll('button')].find((b) => b.textContent === 'Save')!.click(); });
    expect(posts()).toEqual([{ action: 'choose', repositories: ['acme/api', 'acme/web'], provider: 'github', key: 'github-2' }]);
    await act(async () => { (work.querySelector('[data-remove-account]') as HTMLButtonElement).click(); });
    expect(posts()[1]).toEqual({ action: 'disconnect', provider: 'github', key: 'github-2' });
  });
});
