// GitHub App test support for integration tests: an in-process RSA key pair, the App's key as an
// environment variable, and plugins.yaml `jobSources` for both GitHub sources. Nothing here talks to
// github.com.
import { generateKeyPairSync } from 'node:crypto';

export const APP_ID = 4242;
export const SLUG = 'hopper-test';
export const BOT = `${SLUG}[bot]`;

export const KEYS = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** The App's key as the daemon's environment holds it (design.md "Secrets"): give it as `secrets`. */
export const appSecrets = (): Record<string, string | undefined> => ({ GITHUB_APP_PRIVATE_KEY: KEYS.privateKey });

const JOB_KEYS = { executor: 'scripted', defaultCwd: '/tmp', pollSeconds: 3600 };

/**
 * The plugins config `jobSources` for both GitHub sources: `github` (the connected account's,
 * github-account) omitted when false; `github-app` with this app's id and slug. Both sync only on syncNow.
 */
export function jobSourcesDoc(o: { github?: Record<string, unknown> | false; githubApp?: Record<string, unknown> } = {}) {
  return [
    ...(o.github === false ? [] : [{ name: 'github', plugin: 'github-account', options: { ...JOB_KEYS, ...o.github } }]),
    { name: 'github-app', plugin: 'github-app', options: { appId: APP_ID, slug: SLUG, ...JOB_KEYS, ...o.githubApp } },
  ];
}
