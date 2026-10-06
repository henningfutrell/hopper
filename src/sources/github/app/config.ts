// The GitHub App's identity: its id and slug from the github-app instance's options (the plugins config),
// its private key from the daemon's environment (design.md "Secrets"). A PEM given with literal
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
  | { ok: false; reason: 'missing' | string };

/** A PEM from an environment variable: real newlines, or `\n` escapes. */
export const pemFromEnv = (value: string): string => (value.includes('\n') ? value : value.replaceAll('\\n', '\n')).trim() + '\n';

/** `appId` and `slug` from the options, `privateKey` the variable's value (undefined: unset). */
export function loadGitHubApp(o: { appId?: number; slug?: string; privateKeyEnv: string; privateKey: string | undefined }): GitHubAppLoad {
  if (o.appId === undefined || o.slug === undefined || !o.privateKey?.trim()) {
    const missing = [o.appId === undefined ? 'appId' : '', o.slug === undefined ? 'slug' : '', o.privateKey?.trim() ? '' : o.privateKeyEnv].filter(Boolean);
    return missing.length === 3 ? { ok: false, reason: 'missing' } : { ok: false, reason: `incomplete GitHub App: ${missing.join(', ')} not set` };
  }
  const privateKey = pemFromEnv(o.privateKey);
  try {
    createPrivateKey(privateKey);
  } catch (err) {
    return { ok: false, reason: `${o.privateKeyEnv} is not a private key: ${(err as Error).message}` };
  }
  return { ok: true, app: { appId: o.appId, slug: o.slug, botLogin: `${o.slug}[bot]`, htmlUrl: `https://github.com/apps/${o.slug}`, privateKey } };
}
