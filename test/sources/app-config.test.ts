import { chmodSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitHubAppApi, loadGitHubAppFile } from '../../src/sources/github/app/index.ts';
import { GitHubApiError } from '../../src/sources/github/api.ts';
import { BOT, KEYS, SLUG, clock, tempDir, writeAppFiles } from './fixtures/app/setup.ts';

const dirs: string[] = [];
const dir = () => { const d = tempDir(); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('loadGitHubAppFile', () => {
  it('reads the app file and its private key; no warnings at mode 600', () => {
    const appFile = writeAppFiles(dir(), KEYS.privateKey);
    const r = loadGitHubAppFile(appFile);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.app).toMatchObject({ appId: 4242, slug: SLUG, botLogin: BOT, owner: 'owner', webhookSecretFile: null });
    expect(r.app.privateKey).toBe(KEYS.privateKey);
    expect(r.warnings).toEqual([]);
  });

  it('a missing file is reason "missing"', () => {
    expect(loadGitHubAppFile(join(dir(), 'nope.json'))).toEqual({ ok: false, reason: 'missing' });
  });

  it('invalid JSON, a wrong version, or a missing field is a reason naming the file', () => {
    const d = dir();
    const f = join(d, 'github-app.json');
    writeFileSync(f, '{ not json');
    const bad = loadGitHubAppFile(f);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain(f);

    writeAppFiles(d, KEYS.privateKey, { version: 2 });
    expect(loadGitHubAppFile(f).ok).toBe(false);
    writeAppFiles(d, KEYS.privateKey, { botLogin: undefined });
    const r = loadGitHubAppFile(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/botLogin/);
  });

  it('an unreadable or invalid private key is a reason naming the key file', () => {
    const d = dir();
    const f = writeAppFiles(d, KEYS.privateKey, { privateKeyFile: join(d, 'missing.pem') });
    const r = loadGitHubAppFile(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('missing.pem');

    const g = writeAppFiles(d, 'not a key');
    const r2 = loadGitHubAppFile(g);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain('github-app.pem');
  });

  it('expands ~ in privateKeyFile against the home directory', () => {
    const home = dir();
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      writeAppFiles(home, KEYS.privateKey);
      const f = writeAppFiles(home, KEYS.privateKey, { privateKeyFile: '~/github-app.pem' });
      const r = loadGitHubAppFile(f);
      expect(r.ok && r.app.privateKey).toBe(KEYS.privateKey);
      expect(loadGitHubAppFile('~/github-app.json').ok).toBe(true);
    } finally {
      process.env.HOME = prev;
    }
  });

  it('warns when the app file or the key is readable by group or others', () => {
    const d = dir();
    const f = writeAppFiles(d, KEYS.privateKey);
    chmodSync(join(d, 'github-app.pem'), 0o644);
    const r = loadGitHubAppFile(f);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.join('\n')).toMatch(/github-app\.pem.*644/);
  });
});

describe('createGitHubAppApi: lazy, identity from the app file', () => {
  it('constructing with no app file does not throw; first use is a permanent "no app configured"', async () => {
    const api = createGitHubAppApi({ appFile: join(dir(), 'github-app.json'), baseUrl: 'http://127.0.0.1:9', clock });
    expect(api.appStatus()).toEqual({ ok: false, reason: 'missing' });
    const err = await api.getIssue('h/a', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect((err as GitHubApiError).permanent).toBe(true);
    expect((err as GitHubApiError).message).toMatch(/no app configured/);
  });

  it('botLogin and whoami are the configured bot; appStatus reports slug and htmlUrl', async () => {
    const appFile = writeAppFiles(dir(), KEYS.privateKey);
    const api = createGitHubAppApi({ appFile, baseUrl: 'http://127.0.0.1:9', clock });
    expect(await api.botLogin!()).toBe(BOT);
    expect(await api.whoami()).toBe(BOT);
    expect(api.appStatus()).toEqual({ ok: true, slug: SLUG, botLogin: BOT, htmlUrl: `https://github.com/apps/${SLUG}` });
  });

  it('re-reads the app file when its mtime changes; a file appearing later is picked up', async () => {
    const d = dir();
    const appFile = join(d, 'github-app.json');
    const api = createGitHubAppApi({ appFile, baseUrl: 'http://127.0.0.1:9', clock });
    expect(api.appStatus().ok).toBe(false);
    writeAppFiles(d, KEYS.privateKey);
    expect(await api.botLogin!()).toBe(BOT);
    writeAppFiles(d, KEYS.privateKey, { slug: 'renamed', botLogin: 'renamed[bot]' });
    const later = new Date(Date.now() + 5000);
    utimesSync(appFile, later, later);
    expect(await api.botLogin!()).toBe('renamed[bot]');
  });

  it('searchOpenIssues is never used in app mode: permanent error', async () => {
    const appFile = writeAppFiles(dir(), KEYS.privateKey);
    const api = createGitHubAppApi({ appFile, baseUrl: 'http://127.0.0.1:9', clock });
    await expect(api.searchOpenIssues({ owners: ['h'], label: 'hopper' }))
      .rejects.toMatchObject({ permanent: true, message: expect.stringMatching(/not used in app mode/) });
  });
});
