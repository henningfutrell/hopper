// GitHub App test support for integration tests: an in-process RSA key pair, an app file
// (github-app.json + PEM, mode 600) in a temp dir, plugins.yaml `jobSources` for both GitHub
// sources, and the phase-4 sources.yaml document (migration tests). Nothing here talks to github.com.
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const APP_ID = 4242;
export const SLUG = 'job-hopper-test';
export const BOT = `${SLUG}[bot]`;

export const KEYS = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

export const appFilePath = (dir: string): string => join(dir, 'github-app.json');

/** Writes `<dir>/github-app.json` and its PEM (mode 600), as create-github-app.sh does. */
export function writeAppFile(dir: string): string {
  const pem = join(dir, 'github-app.pem');
  writeFileSync(pem, KEYS.privateKey, { mode: 0o600 });
  const appFile = appFilePath(dir);
  writeFileSync(appFile, JSON.stringify({
    version: 1, appId: APP_ID, slug: SLUG, botLogin: BOT, clientId: 'Iv23test',
    htmlUrl: `https://github.com/apps/${SLUG}`, owner: 'owner', privateKeyFile: pem,
    webhookSecretFile: null, createdAt: '2026-10-03T00:00:00.000Z',
  }), { mode: 0o600 });
  return appFile;
}

const JOB_KEYS = { authors: ['owner'], executor: 'scripted', defaultCwd: '/tmp', pollSeconds: 3600 };

/**
 * plugins.yaml `jobSources:` for both GitHub sources: `github` (github-gh, pausing while the app
 * file in `dir` is readable) omitted when false; both sync only on syncNow.
 */
export function jobSourcesDoc(dir: string, o: { github?: Record<string, unknown> | false; githubApp?: Record<string, unknown> } = {}) {
  return [
    ...(o.github === false ? [] : [{ name: 'github', plugin: 'github-gh', options: { enabled: 'auto', appFile: appFilePath(dir), ...JOB_KEYS, ...o.github } }]),
    { name: 'github-app', plugin: 'github-app', options: { appFile: appFilePath(dir), ...JOB_KEYS, ...o.githubApp } },
  ];
}

/** A phase-4 sources.yaml document: `github` omitted when false. */
export function sourcesDoc(dir: string, o: { github?: Record<string, unknown> | false; githubApp?: Record<string, unknown> } = {}) {
  return {
    version: 1,
    ...(o.github === false ? {} : { github: { enabled: 'auto', ...JOB_KEYS, ...o.github } }),
    githubApp: { appFile: appFilePath(dir), ...JOB_KEYS, ...o.githubApp },
  };
}
