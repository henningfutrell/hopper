// @vitest-environment happy-dom
// Issue #1448 part 2: the GitLab account on Sources. Not connected, it takes the GitLab URL and a personal access token; a
// refusal says why. Connected, it lists the projects the token reaches to pick, with the GitLab source's sync, and Remove this
// account. A token GitLab refused reads "reconnect needed". It says which issues become jobs, and the token's scopes (issue #1448 part 3). The whole app
// against a fake of the daemon's HTTP surface.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, source, unmount } from './sources-daemon.ts';

afterEach(unmount);

const ACCOUNT = { baseUrl: 'https://gitlab.example.com', account: 'ada', userId: 7, connectedAt: '2026-10-17T00:00:00.000Z', projects: ['ada/tools'], reached: ['ada/tools', 'acme/platform/api'], reachedAt: '2026-10-17T00:00:00.000Z' };
const SOURCES = { sources: [source('gitlab-account', 'gitlab-account', 'ok', { login: 'ada', label: 'hopper', issues: 1 })] };
const panel = () => document.querySelector('[data-gitlab-account]');
const posts = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url) === '/ui/api/gitlab-account' && init?.method === 'POST')
  .map(([, init]) => JSON.parse(String(init!.body)) as unknown);
const type = async (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

describe('Sources view: the GitLab account', () => {
  it('connects with a GitLab URL and a token; a refusal says why', async () => {
    await boot({ '/api/gitlab-account': { account: { state: 'not-connected' } }, '/ui/api/gitlab-account': { account: { state: 'failed', error: 'GitLab refused the token: 401' } } });
    await vi.waitFor(() => expect(panel()?.getAttribute('data-gitlab-account')).toBe('not-connected'));
    expect(document.body.textContent).toContain('An issue that your GitLab account wrote, labelled and assigned to itself becomes a job');
    expect(document.body.textContent).toContain('write_repository');
    await type(panel()!.querySelector('[data-gitlab-url]') as HTMLInputElement, 'https://gitlab.example.com');
    await type(panel()!.querySelector('[data-gitlab-token]') as HTMLInputElement, 'glpat-ada');
    await act(async () => { (panel()!.querySelector('[data-gitlab-token-connect]') as HTMLButtonElement).click(); });
    expect(posts()).toEqual([{ action: 'connect', token: 'glpat-ada', baseUrl: 'https://gitlab.example.com' }]);
    await vi.waitFor(() => expect(panel()?.querySelector('[data-gitlab-error]')?.textContent).toContain('GitLab refused the token'));
  });

  it('lists the projects the token reaches to pick, with the source\'s sync, and removes the account', async () => {
    await boot({ '/api/sources': SOURCES, '/api/gitlab-account': { account: { state: 'connected', ...ACCOUNT } }, '/ui/api/gitlab-account': { account: { state: 'connected', ...ACCOUNT, projects: ['ada/tools', 'acme/platform/api'] } } });
    await vi.waitFor(() => expect(panel()?.querySelector('[data-gitlab-project="acme/platform/api"]')).not.toBeNull());
    expect(panel()!.textContent).toContain('Connected as ada at https://gitlab.example.com');
    expect(panel()!.querySelector('[data-gitlab-projects-summary]')!.textContent).toBe('1 of 2 projects picked');
    expect(panel()!.querySelector('[data-source-sync]')).not.toBeNull();
    await act(async () => { (panel()!.querySelector('[data-gitlab-project="acme/platform/api"] input') as HTMLInputElement).click(); });
    await act(async () => { [...panel()!.querySelectorAll('button')].find((b) => b.textContent === 'Save')!.click(); });
    expect(posts()).toEqual([{ action: 'choose', projects: ['ada/tools', 'acme/platform/api'] }]);
    await act(async () => { (panel()!.querySelector('[data-gitlab-remove]') as HTMLButtonElement).click(); });
    expect(posts()[1]).toEqual({ action: 'disconnect' });
  });

  it('reads "reconnect needed" when GitLab refused the token, and takes a new one', async () => {
    await boot({ '/api/gitlab-account': { account: { state: 'expired', error: 'GitLab refused the token (401)', ...ACCOUNT } } });
    await vi.waitFor(() => expect(panel()?.querySelector('[data-expired]')).not.toBeNull());
    expect(document.body.textContent).toContain('reconnect needed');
    expect((panel()!.querySelector('[data-gitlab-url]') as HTMLInputElement).value).toBe('https://gitlab.example.com');
    expect(panel()!.querySelector('[data-gitlab-token-connect]')!.textContent).toContain('Connect with a new token');
  });
});
