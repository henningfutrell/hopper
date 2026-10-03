// Test support for the GitHub App adapter: in-process RSA keys, app files in a temp dir, and the
// node:http fake GitHub. Nothing here talks to github.com.

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGitHubServer } from '../../../../src/sources/github/app/fake-server.ts';
import type { FakeGitHubOptions, FakeGitHubServer } from '../../../../src/sources/github/app/fake-server.ts';
import { createGitHubAppApi } from '../../../../src/sources/github/app/index.ts';
import type { GitHubAppApi } from '../../../../src/sources/github/app/index.ts';

export const APP_ID = 4242;
export const SLUG = 'job-hopper-test';
export const BOT = `${SLUG}[bot]`;
export const clock = { now: () => new Date() };

export interface KeyPair { publicKey: string; privateKey: string }

export function generateKeys(): KeyPair {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

export const KEYS = generateKeys();

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'jh-app-'));
}

/** Writes github-app.json (+ the PEM) into `dir`, mode 600; returns the app file path. */
export function writeAppFiles(dir: string, privateKey: string, overrides: Record<string, unknown> = {}): string {
  const pem = join(dir, 'github-app.pem');
  writeFileSync(pem, privateKey, { mode: 0o600 });
  const appFile = join(dir, 'github-app.json');
  const app = {
    version: 1, appId: APP_ID, slug: SLUG, botLogin: BOT, clientId: 'Iv23test',
    htmlUrl: `https://github.com/apps/${SLUG}`, owner: 'owner', privateKeyFile: pem,
    webhookSecretFile: null, createdAt: '2026-10-03T00:00:00.000Z', ...overrides,
  };
  writeFileSync(appFile, JSON.stringify(app), { mode: 0o600 });
  return appFile;
}

export interface AppHarness {
  fake: FakeGitHubServer;
  api: GitHubAppApi;
  appFile: string;
  dir: string;
  close(): Promise<void>;
}

/** Fake GitHub + an adapter pointed at it. `privateKey` defaults to the matching key. */
export async function startApp(o: Partial<FakeGitHubOptions> & { privateKey?: string } = {}): Promise<AppHarness> {
  const { privateKey, ...fakeOpts } = o;
  const fake = await createFakeGitHubServer({
    appId: APP_ID, publicKeyPem: KEYS.publicKey, slug: SLUG, installations: [], ...fakeOpts,
  });
  const dir = tempDir();
  const appFile = writeAppFiles(dir, privateKey ?? KEYS.privateKey);
  const api = createGitHubAppApi({ appFile, baseUrl: fake.url, clock });
  return {
    fake, api, appFile, dir,
    async close() {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Requests the fake saw, as "METHOD /path". */
export function seen(fake: FakeGitHubServer): string[] {
  return fake.state.requests.map((r) => `${r.method} ${r.path}`);
}
