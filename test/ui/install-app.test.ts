// @vitest-environment happy-dom
// Install the hopper's app on GitHub (issue #2759): one prominent button, at the top of Sources' GitHub section, that opens
// GitHub's install page, where a person picks their own account or an organization and its repositories. Shown also on the
// Dashboard while the app reaches no repository, so a person setting up the hopper finds it first. Never for a personal
// access token, or a hopper with no app.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, unmount } from './sources-daemon.ts';

afterEach(unmount);

const INSTALL = 'https://github.com/apps/hopper-qm/installations/new';
const BASE = { provider: 'github', key: 'github', via: 'the hopper\'s app' };
const notConnected = { ...BASE, state: 'not-connected', installUrl: INSTALL };
const connected = (installations: unknown[], more: Record<string, unknown> = {}) => ({
  ...BASE, state: 'connected', account: 'octo-user', connectedAt: '2026-10-01T00:00:00.000Z', jobRepositories: [],
  installUrl: INSTALL, configUrl: 'https://github.com/settings/installations', installations, ...more,
});
const INSTALLED = [{ account: 'octo-user', repositorySelection: 'all', repositories: ['octo-user/hopper'], settingsUrl: 'https://github.com/settings/installations/1' }];
const withAccount = (github: unknown) => ({ '/api/connected-accounts': { accounts: [github] } });
const button = () => document.querySelector('[data-install-app]') as HTMLAnchorElement | null;
const settle = () => vi.waitFor(() => expect(document.querySelector('[data-connected-account="github"]')).not.toBeNull());

describe('Install the hopper app on GitHub (#2759)', () => {
  it('not connected: Sources opens with the button, which goes to GitHub\'s install page in a new tab', async () => {
    await boot(withAccount(notConnected));
    await vi.waitFor(() => expect(button()).not.toBeNull());
    expect(button()!.getAttribute('href')).toBe(INSTALL);
    expect(button()!.getAttribute('target')).toBe('_blank');
    expect(button()!.getAttribute('data-install-app')).toBe('needed');
    expect(button()!.textContent).toBe('Install the app on GitHub');
    expect(document.querySelector('[data-install-app-callout]')!.textContent).toContain('your own account or an organization');
    // It comes before the account's panel.
    const panel = document.querySelector('[data-connected-account="github"]')!;
    expect(button()!.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('connected, installed nowhere: the button asks to install it', async () => {
    await boot(withAccount(connected([])));
    await vi.waitFor(() => expect(button()?.getAttribute('data-install-app')).toBe('needed'));
  });

  it('installed: the button stays, quieter, to add the app to another account or organization', async () => {
    await boot(withAccount(connected(INSTALLED)));
    await vi.waitFor(() => expect(button()?.getAttribute('data-install-app')).toBe('more'));
    expect(button()!.getAttribute('href')).toBe(INSTALL);
    expect(button()!.textContent).toBe('Install the app on another account or organization');
  });

  it('a personal access token, or a hopper with no app: no button', async () => {
    await boot(withAccount(connected(INSTALLED, { grantedBy: 'token', installUrl: undefined, configUrl: undefined })));
    await settle();
    expect(button()).toBeNull();
    await unmount();
    await boot(withAccount({ ...BASE, state: 'not-connected' }));
    await settle();
    expect(button()).toBeNull();
  });

  it('the Dashboard shows the button while the app reaches no repository, and not once it does', async () => {
    await boot(withAccount(notConnected), '#dashboard');
    await vi.waitFor(() => expect(button()?.getAttribute('href')).toBe(INSTALL));
    await unmount();
    await boot(withAccount(connected(INSTALLED)), '#dashboard');
    await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(button()).toBeNull();
  });

  it('the Dashboard shows nothing, and throws nothing, when the answer lists no accounts (issue #2769)', async () => {
    const thrown: unknown[] = [];
    const seen = (e: unknown) => { thrown.push(e); };
    process.on('unhandledRejection', seen);
    try {
      await boot({ '/api/connected-accounts': {} }, '#dashboard');
      await vi.waitFor(() => expect(document.querySelector('main')?.textContent).toBeTruthy());
      await new Promise((r) => setTimeout(r, 50));
      expect(button()).toBeNull();
      expect(thrown).toEqual([]);
    } finally {
      process.off('unhandledRejection', seen);
    }
  });
});
