// The GitHub App's identity: its id and slug from the github-app instance's options (the plugins config),
// its private key from the vault's system scope (issue #1243, `key.ts`). A PEM given with literal
// `\n` escapes (one line, as most env files and secret stores want it) is read as the PEM it spells.
import { createPrivateKey } from 'node:crypto';

export interface GitHubApp {
  appId: number;
  slug: string;
  /** `<slug>[bot]`: the app's author name on GitHub. */
  botLogin: string;
  /** https://github.com/apps/<slug> */
  htmlUrl: string;
  privateKey: string;
}

export type GitHubAppLoad =
  | { ok: true; app: GitHubApp }
  /** `missing`: the identity's parts not set, by name (issue #1243); empty when the key is set but is no key. */
  | { ok: false; reason: 'missing' | string; missing: string[] };

/** A PEM from an environment variable: real newlines, or `\n` escapes. */
export const pemFromEnv = (value: string): string => (value.includes('\n') ? value : value.replaceAll('\\n', '\n')).trim() + '\n';

/** How the setup problem names the key when none is kept (issue #1243). */
export const PRIVATE_KEY = 'private key';

/** `appId` and `slug` from the options, `privateKey` the key kept (undefined: none). */
export function loadGitHubApp(o: { appId?: number; slug?: string; privateKey: string | undefined }): GitHubAppLoad {
  if (o.appId === undefined || o.slug === undefined || !o.privateKey?.trim()) {
    const missing = [o.appId === undefined ? 'appId' : '', o.slug === undefined ? 'slug' : '', o.privateKey?.trim() ? '' : PRIVATE_KEY].filter(Boolean);
    return missing.length === 3 ? { ok: false, reason: 'missing', missing } : { ok: false, reason: `incomplete GitHub App: ${missing.join(', ')} not set`, missing };
  }
  const privateKey = pemFromEnv(o.privateKey);
  try {
    createPrivateKey(privateKey);
  } catch (err) {
    return { ok: false, reason: `the private key is not valid: ${(err as Error).message}`, missing: [] };
  }
  return { ok: true, app: { appId: o.appId, slug: o.slug, botLogin: `${o.slug}[bot]`, htmlUrl: `https://github.com/apps/${o.slug}`, privateKey } };
}
