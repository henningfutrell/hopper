// Test support for the GitHub App adapter: in-process RSA keys, the app's key as a value, and the
// node:http fake GitHub. Nothing here talks to github.com.

import { generateKeyPairSync } from 'node:crypto';
import { createFakeGitHubServer } from '../../../../src/sources/github/app/fake-server.ts';
import type { FakeGitHubOptions, FakeGitHubServer } from '../../../../src/sources/github/app/fake-server.ts';
import { createGitHubAppApi, loadGitHubApp } from '../../../../src/sources/github/app/index.ts';
import type { GitHubAppApi } from '../../../../src/sources/github/app/index.ts';

export const APP_ID = 4242;
export const SLUG = 'job-hopper-test';
export const BOT = `${SLUG}[bot]`;
export const KEY_ENV = 'GITHUB_APP_PRIVATE_KEY';
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

export interface AppHarness {
  fake: FakeGitHubServer;
  api: GitHubAppApi;
  close(): Promise<void>;
}

/** Fake GitHub + an adapter pointed at it. `privateKey` defaults to the matching key. */
export async function startApp(o: Partial<FakeGitHubOptions> & { privateKey?: string } = {}): Promise<AppHarness> {
  const { privateKey, ...fakeOpts } = o;
  const fake = await createFakeGitHubServer({
    appId: APP_ID, publicKeyPem: KEYS.publicKey, slug: SLUG, installations: [], ...fakeOpts,
  });
  const key = privateKey ?? KEYS.privateKey;
  const app = () => loadGitHubApp({ appId: APP_ID, slug: SLUG, privateKeyEnv: KEY_ENV, privateKey: key });
  const api = createGitHubAppApi({ app, keyEnv: KEY_ENV, baseUrl: fake.url, clock });
  return { fake, api, close: () => fake.close() };
}

/** Requests the fake saw, as "METHOD /path". */
export function seen(fake: FakeGitHubServer): string[] {
  return fake.state.requests.map((r) => `${r.method} ${r.path}`);
}
