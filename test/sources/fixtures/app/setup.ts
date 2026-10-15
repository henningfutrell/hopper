// Test support for the connected account's adapter over the node:http fake GitHub: the adapter with the account's token,
// pointed at the fake. Nothing here talks to github.com.

import { createFakeGitHubServer } from '../../../../src/sources/github/http/index.ts';
import type { FakeGitHubOptions, FakeGitHubServer } from '../../../../src/sources/github/http/index.ts';
import { FAKE_USER_TOKEN } from '../../../../src/sources/github/http/fake-state.ts';
import { createAccountGitHubApi } from '../../../../src/sources/github/account/api.ts';
import type { GitHubApi } from '../../../../src/sources/github/api.ts';

/** The connected account's login: its writes appear under it. */
export const LOGIN = 'owner';
export const clock = { now: () => new Date() };

export interface AppHarness {
  fake: FakeGitHubServer;
  api: GitHubApi;
  close(): Promise<void>;
}

/** Fake GitHub + the connected account's adapter pointed at it. `token` defaults to the one the fake takes. */
export async function startApp(o: Partial<FakeGitHubOptions> & { token?: string } = {}): Promise<AppHarness> {
  const { token, ...fakeOpts } = o;
  const fake = await createFakeGitHubServer({ login: LOGIN, installations: [], ...fakeOpts });
  const api = createAccountGitHubApi({ apiUrl: fake.url, token: async () => token ?? FAKE_USER_TOKEN });
  return { fake, api, close: () => fake.close() };
}

/** Requests the fake saw, as "METHOD /path". */
export function seen(fake: FakeGitHubServer): string[] {
  return fake.state.requests.map((r) => `${r.method} ${r.path}`);
}
