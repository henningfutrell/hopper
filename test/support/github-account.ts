// The connected GitHub account for integration tests (issue #359: the one way the hopper reads GitHub as
// the user): a github-account job source over the in-memory fake GitHub (AppSeams.github), and the
// account connected straight in the user's store, with the job repositories chosen. Nothing talks to
// github.com.
import { ADMIN_ID } from '../../src/domain/types.ts';
import type { TestApp } from './app.ts';

/** A plugins config `jobSources` entry: the connected account's source, named `github`, syncing only on syncNow. */
export function githubSource(options: Record<string, unknown> = {}) {
  return { name: 'github', plugin: 'github-account', options: { pollSeconds: 3600, authors: ['owner'], ...options } };
}

/** Connect `login`'s GitHub account for the user, its jobs using `repositories`. `expiresAt`: its token's end. */
export function connectGitHub(a: TestApp, repositories: string[], o: { login?: string; userId?: string; expiresAt?: string } = {}): void {
  const { store } = a.user(o.userId ?? ADMIN_ID);
  store.connectedAccounts.put({
    provider: 'github', account: o.login ?? 'owner', subject: '1', accessToken: 'test-account-token',
    connectedAt: '2026-10-07T00:00:00.000Z', ...(o.expiresAt ? { expiresAt: o.expiresAt } : {}),
  });
  store.settings.setJobRepositories('github', repositories);
}
