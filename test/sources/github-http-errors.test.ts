import { afterEach, describe, expect, it } from 'vitest';
import { GitHubApiError } from '../../src/sources/github/api.ts';
import { startApp } from './fixtures/app/setup.ts';
import type { AppHarness } from './fixtures/app/setup.ts';

let h: AppHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const oneRepo = [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: [{ number: 1, labels: ['hopper'] }] }, { owner: 'owner', name: 'b' }] }];

describe('Account adapter: error classification', () => {
  it('a token GitHub refuses is rejected: permanent, naming the connected account\'s token', async () => {
    h = await startApp({ installations: oneRepo, token: 'ghu_not-the-one' });
    const err = await h.api.getIssue('owner/a', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err).toMatchObject({ permanent: true, status: 401 });
    expect((err as Error).message).toContain("the connected account's token");
  });

  it('5xx is transient; 403/404 are permanent; a rate-limit 403 is transient', async () => {
    h = await startApp({ installations: oneRepo });
    h.fake.fail('GET /repos/owner/a/issues/1', 502, 'Bad Gateway', 1);
    await expect(h.api.getIssue('owner/a', 1)).rejects.toMatchObject({ permanent: false, status: 502 });
    expect(await h.api.getIssue('owner/a', 1)).toMatchObject({ number: 1 });

    h.fake.fail('GET /repos/owner/a/issues/1/comments', 403, 'Resource not accessible by integration', 1);
    await expect(h.api.listComments('owner/a', 1)).rejects.toMatchObject({ permanent: true, status: 403 });
    h.fake.fail('GET /repos/owner/a/issues/1/comments', 403, 'API rate limit exceeded for installation', 1);
    await expect(h.api.listComments('owner/a', 1)).rejects.toMatchObject({ permanent: false, status: 403 });
  });

  it('a network failure is transient', async () => {
    h = await startApp({ installations: oneRepo });
    await h.fake.close();
    await expect(h.api.getIssue('owner/a', 1)).rejects.toMatchObject({ permanent: false });
  });
});
