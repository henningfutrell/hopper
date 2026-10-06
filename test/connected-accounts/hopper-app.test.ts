// The hopper's app (issue #214, docs/design.md "Sign in with GitHub, and work through that connection"):
// every hopper ships the public identity of one GitHub App, so a fresh hopper offers Sign in with GitHub
// with nothing set. Only the client id and the slug ship: nothing secret.
import { describe, expect, it } from 'vitest';
import { SHIPPED_APPS, hopperApps, installUrl } from '../../src/connected-accounts/hopper-app.ts';

describe("the hopper's app", () => {
  it('ships a GitHub App client id and slug, so sign-in works with nothing set', () => {
    expect(SHIPPED_APPS.github.clientId).toMatch(/^Iv\d+[A-Za-z0-9]+$/);
    expect(SHIPPED_APPS.github.slug).toMatch(/^[a-z0-9-]+$/);
    const app = hopperApps({ github: {} }).github;
    expect(app.clientId).toBe(SHIPPED_APPS.github.clientId);
    expect(installUrl(app)).toBe(`https://github.com/apps/${SHIPPED_APPS.github.slug}/installations/new`);
  });

  it('ships nothing but the public identity', () => {
    expect(Object.keys(SHIPPED_APPS.github).sort()).toEqual(['clientId', 'slug']);
  });

  it('lets the environment name another app', () => {
    const app = hopperApps({ github: { url: 'https://ghe.example.com/', clientId: 'Iv1other', slug: 'other' } }).github;
    expect(app).toEqual({
      provider: 'github', url: 'https://ghe.example.com', apiUrl: 'https://ghe.example.com/api/v3', clientId: 'Iv1other', slug: 'other',
    });
  });
});
