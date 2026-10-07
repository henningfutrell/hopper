import { describe, expect, it } from 'vitest';
import { GitHubApiError } from '../../src/sources/github/api.ts';
import { createGitHubAppApi, loadGitHubApp, pemFromEnv } from '../../src/sources/github/app/index.ts';
import type { GitHubAppLoad } from '../../src/sources/github/app/index.ts';
import { APP_ID, BOT, KEYS, KEY_ENV, SLUG, clock } from './fixtures/app/setup.ts';

const complete = { appId: APP_ID, slug: SLUG, privateKeyEnv: KEY_ENV, privateKey: KEYS.privateKey };

describe('loadGitHubApp', () => {
  it('a complete identity is ok: botLogin <slug>[bot], htmlUrl, the key', () => {
    const r = loadGitHubApp(complete);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.app).toMatchObject({ appId: APP_ID, slug: SLUG, botLogin: BOT, htmlUrl: `https://github.com/apps/${SLUG}` });
    expect(r.app.privateKey.trim()).toBe(KEYS.privateKey.trim());
  });

  it('nothing set is reason "missing"', () => {
    expect(loadGitHubApp({ privateKeyEnv: KEY_ENV, privateKey: undefined })).toEqual({ ok: false, reason: 'missing' });
  });

  it.each([
    ['appId', { appId: undefined }],
    ['slug', { slug: undefined }],
    [KEY_ENV, { privateKey: undefined }],
    [KEY_ENV, { privateKey: '  ' }],
  ])('a missing %s is named in the reason', (name, change) => {
    const r = loadGitHubApp({ ...complete, ...change });
    expect(r).toEqual({ ok: false, reason: `incomplete GitHub App: ${name} not set` });
  });

  it('several missing pieces are all named', () => {
    const r = loadGitHubApp({ ...complete, appId: undefined, privateKey: undefined });
    expect(r).toEqual({ ok: false, reason: `incomplete GitHub App: appId, ${KEY_ENV} not set` });
  });

  it('a key with literal \\n escapes reads as a PEM', () => {
    const oneLine = KEYS.privateKey.trim().replaceAll('\n', '\\n');
    expect(oneLine).not.toContain('\n');
    const r = loadGitHubApp({ ...complete, privateKey: oneLine });
    expect(r.ok && r.app.privateKey).toBe(KEYS.privateKey.trim() + '\n');
  });

  it('a value that is not a key is refused, naming the variable', () => {
    const r = loadGitHubApp({ ...complete, privateKey: 'not a key' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(`${KEY_ENV} is not a private key`);
  });
});

describe('pemFromEnv', () => {
  it('keeps real newlines, expands \\n escapes, ends with one newline', () => {
    expect(pemFromEnv('a\nb\n')).toBe('a\nb\n');
    expect(pemFromEnv('a\\nb')).toBe('a\nb\n');
  });
});

describe('createGitHubAppApi: lazy, identity from the app getter', () => {
  const api = (app: () => GitHubAppLoad) => createGitHubAppApi({ app, keyEnv: KEY_ENV, baseUrl: 'http://127.0.0.1:9', clock });

  it('constructing with no app does not throw; first use is a permanent "no app configured"', async () => {
    const a = api(() => ({ ok: false, reason: 'missing' }));
    expect(a.appStatus()).toEqual({ ok: false, reason: 'missing' });
    const err = await a.getIssue('h/a', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as GitHubApiError).permanent).toBe(true);
    expect((err as GitHubApiError).message).toMatch(/no app configured/);
  });

  it('botLogin is the configured bot; appStatus reports slug and htmlUrl', async () => {
    const a = api(() => loadGitHubApp(complete));
    expect(await a.botLogin!()).toBe(BOT);
    expect(a.appStatus()).toEqual({ ok: true, slug: SLUG, botLogin: BOT, htmlUrl: `https://github.com/apps/${SLUG}` });
  });

  it('asks the getter every time: an identity appearing or changing later is picked up', async () => {
    let now: GitHubAppLoad = { ok: false, reason: 'missing' };
    const a = api(() => now);
    expect(a.appStatus().ok).toBe(false);
    now = loadGitHubApp(complete);
    expect(await a.botLogin!()).toBe(BOT);
    now = loadGitHubApp({ ...complete, slug: 'renamed' });
    expect(await a.botLogin!()).toBe('renamed[bot]');
  });
});
