import { afterEach, describe, expect, it } from 'vitest';
import { startApp } from './fixtures/app/setup.ts';
import type { AppHarness } from './fixtures/app/setup.ts';

let h: AppHarness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe('App adapter: Projects (v2) over GraphQL', () => {
  it('reads an organization project: items in order with lowercased field values', async () => {
    h = await startApp({
      installations: [{ id: 22, account: 'acme', accountType: 'Organization', repos: [{ owner: 'acme', name: 'x' }] }],
      projects: [{ owner: 'acme', number: 3, items: [
        { url: 'https://github.com/acme/x/issues/2', fields: { Priority: 'P1', Status: 'Todo' } },
        { url: 'https://github.com/acme/x/issues/1', fields: { Estimate: 3 } },
      ] }],
    });
    const items = await h.api.projectItems('acme', 3);
    expect(items).toEqual([
      { url: 'https://github.com/acme/x/issues/2', index: 0, fields: { priority: 'P1', status: 'Todo' } },
      { url: 'https://github.com/acme/x/issues/1', index: 1, fields: { estimate: 3 } },
    ]);
    const gql = h.fake.state.requests.filter((r) => r.path === '/graphql');
    expect(gql).toHaveLength(1);
    expect(gql[0]!.auth).toBe('token');
  });

  it('tries organization, then user; a user-owned project failure is a permanent error the source falls back from', async () => {
    h = await startApp({
      installations: [{ id: 11, account: 'owner', repos: [{ owner: 'owner', name: 'a' }] }],
      projects: [{ owner: 'owner', number: 1, items: [{ url: 'https://github.com/owner/a/issues/1', fields: { Priority: 'P0' } }] }],
    });
    const err = await h.api.projectItems('owner', 1).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'GitHubApiError', permanent: true });
    expect((err as Error).message).toMatch(/owner\/projects\/1/);
    const queries = h.fake.state.requests.filter((r) => r.path === '/graphql').map((r) => (r.body as { query: string }).query);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatch(/organization\(login/);
    expect(queries[1]).toMatch(/user\(login/);
  });

  it('a project that does not exist on an organization is a permanent error', async () => {
    h = await startApp({ installations: [{ id: 22, account: 'acme', accountType: 'Organization', repos: [{ owner: 'acme', name: 'x' }] }] });
    await expect(h.api.projectItems('acme', 9)).rejects.toMatchObject({ permanent: true });
  });
});
