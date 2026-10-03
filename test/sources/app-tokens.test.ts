import { afterEach, describe, expect, it } from 'vitest';
import { GitHubApiError } from '../../src/sources/github/api.ts';
import { generateKeys, startApp } from './fixtures/app/setup.ts';
import type { AppHarness } from './fixtures/app/setup.ts';

let h: AppHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const oneRepo = [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a', issues: [{ number: 1, labels: ['hopper'] }] }, { owner: 'owner', name: 'b' }] }];

describe('App adapter: per-repo scoped tokens', () => {
  it('mints a token scoped to exactly one repo with issues: write; two mints are two tokens', async () => {
    h = await startApp({ installations: oneRepo });
    const t1 = await h.api.mintRepoToken!('owner/a');
    const t2 = await h.api.mintRepoToken!('owner/a');
    expect(t1.token).not.toBe(t2.token);
    expect(Date.parse(t1.expiresAt)).toBeGreaterThan(Date.now() + 50 * 60_000);
    const mints = h.fake.state.tokens.filter((t) => t.body.repositories !== undefined);
    expect(mints).toHaveLength(2);
    for (const m of mints) {
      expect(m.installationId).toBe(11);
      expect(m.body).toEqual({ repositories: ['a'], permissions: { issues: 'write' } });
    }
  });

  it('the scoped token reaches its repo and nothing else', async () => {
    h = await startApp({ installations: oneRepo });
    const { token } = await h.api.mintRepoToken!('owner/a');
    const get = (repo: string) => fetch(`${h!.fake.url}/repos/${repo}/issues/1`, { headers: { authorization: `token ${token}` } });
    expect((await get('owner/a')).status).toBe(200);
    expect((await get('owner/b')).status).toBe(404);
  });
});

describe('App adapter: error classification', () => {
  it('a JWT signed with the wrong key is rejected: permanent, naming the app config file', async () => {
    h = await startApp({ installations: oneRepo, privateKey: generateKeys().privateKey });
    const err = await h.api.listInstalledRepos!().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err).toMatchObject({ permanent: true, status: 401 });
    expect((err as Error).message).toContain(h.appFile);
    const status = h.api.appStatus();
    expect(status.ok).toBe(false);
    if (!status.ok) expect(status.reason).toMatch(/401|rejected/);
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
    await expect(h.api.listInstalledRepos!()).rejects.toMatchObject({ permanent: false });
  });
});
