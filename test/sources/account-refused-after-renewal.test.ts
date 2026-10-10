// Issue #647: GitHub refusing (a 401) the token it just renewed is GitHub refusing the connection. The account
// source's GitHub calls report that token back to the renewer, which ends the connection: reconnect needed. Fake
// GitHub on loopback, refusing every token.
import { afterEach, describe, expect, it } from 'vitest';
import { createAccountGitHubApi } from '../../src/sources/github/account/api.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function forge(): Promise<FakeForge> {
  const f = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => f.close());
  return f;
}

describe('a 401 on the token just renewed (#647)', () => {
  it('is reported to the renewer, once, and the call fails', async () => {
    const github = await forge();
    const refused: string[] = [];
    const api = createAccountGitHubApi({
      apiUrl: `${github.url}/api/v3`,
      token: async () => 'gho_first',
      renew: async (token) => { refused.push(token); return refused.length === 1 ? 'gho_renewed' : 'gho_other'; },
    });
    await expect(api.listOpenIssues('octo-user/tools', 'hopper')).rejects.toThrow();
    expect(refused).toEqual(['gho_first', 'gho_renewed']);
  });
});
