// @vitest-environment happy-dom
// The GitHub App source's setup card in Sources (issue #1243 part 3): it lists the GitHub Apps already installed on the
// organizations the person's GitHub connection knows, and Use this app sets that app's id and slug on the source, as an edit
// of its options in the plugins config (the source's other options kept). An organization GitHub refuses to list is named.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, GITHUB_SESSION, source, unmount } from './sources-daemon.ts';

afterEach(unmount);

const setupProblem = { missing: ['appId', 'slug', 'private key'], reason: 'missing', help: 'github-app-setup' };
const PLUGINS = {
  config: { version: 'v-1', loadedAt: '2026-10-15T00:00:00.000Z' },
  plugins: [], instances: [{ role: 'job-source', instance: { name: 'github-app', plugin: 'github-app', options: { pollSeconds: 300 } } }],
};
const INSTALLED = {
  apps: [{ account: 'octo-org', appId: 4242, slug: 'octo-intake', settingsUrl: 'https://github.com/organizations/octo-org/settings/installations/100' }],
  refused: [{ account: 'other-org', error: 'GitHub answered 403: only an owner of the organization can list its apps' }],
};

const posts = (path: string) => (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls
  .filter(([u, i]) => String(u) === path && i?.method === 'POST').map(([, i]) => JSON.parse(String(i!.body)) as unknown);
const card = () => document.querySelector('[data-setup-problem="github-app"]');
const button = (text: string) => [...(card()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === text) as HTMLButtonElement | undefined;

describe('Sources view: pick an installed GitHub App', () => {
  it('lists the apps installed on the organizations, and Use this app sets its id and slug on the source (#1243)', async () => {
    await boot({
      '/ui/api/session': GITHUB_SESSION,
      '/api/sources': { sources: [{ ...source('github-app', 'github-app', 'needs-setup', { mode: 'app' }), setupProblem }] },
      '/api/github-apps': INSTALLED, '/api/plugins': PLUGINS, '/ui/api/plugins': PLUGINS,
    });
    await vi.waitFor(() => expect(button('List installed apps')).toBeDefined());
    await act(async () => { button('List installed apps')!.click(); });
    await vi.waitFor(() => expect(card()?.querySelector('[data-installed-app="4242"]')?.textContent).toContain('octo-intake'));
    expect(card()?.querySelector('[data-installed-app="4242"]')?.textContent).toContain('octo-org');
    expect(card()?.querySelector('[data-installed-apps-refused]')?.textContent).toContain('other-org');
    const use = card()!.querySelector('[data-installed-app="4242"] button') as HTMLButtonElement;
    expect(use.textContent).toBe('Use this app');
    await act(async () => { use.click(); });
    await vi.waitFor(() => expect(posts('/ui/api/plugins')).toHaveLength(1));
    expect(posts('/ui/api/plugins')[0]).toEqual({
      action: 'options', role: 'job-source', name: 'github-app', options: { pollSeconds: 300, appId: 4242, slug: 'octo-intake' }, version: 'v-1',
    });
  });

  it('with no GitHub connection, says to connect GitHub (#1243)', async () => {
    await boot({
      '/ui/api/session': GITHUB_SESSION,
      '/api/sources': { sources: [{ ...source('github-app', 'github-app', 'needs-setup', { mode: 'app' }), setupProblem }] },
      '/api/github-apps': { apps: [], refused: [], notConnected: 'GitHub is not connected: Sources → Connect GitHub' },
    });
    await vi.waitFor(() => expect(button('List installed apps')).toBeDefined());
    await act(async () => { button('List installed apps')!.click(); });
    await vi.waitFor(() => expect(card()?.querySelector('[data-installed-apps-none]')?.textContent).toContain('GitHub is not connected'));
  });
});
