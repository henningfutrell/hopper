// The app config file (`github-app.json`, written by scripts/create-github-app.*) and its
// private key. Synchronous: two small local files, read on first use and on mtime change.

import { createPrivateKey } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const appFileSchema = z.object({
  version: z.literal(1),
  appId: z.number().int().positive(),
  slug: z.string().min(1),
  botLogin: z.string().min(1),
  clientId: z.string().optional(),
  htmlUrl: z.string().min(1),
  owner: z.string().min(1),
  privateKeyFile: z.string().min(1),
  webhookSecretFile: z.string().min(1).nullable().optional(),
  createdAt: z.string().optional(),
});

export type GitHubAppFile = z.infer<typeof appFileSchema>;
export type GitHubApp = GitHubAppFile & { privateKey: string };
export type GitHubAppLoad =
  | { ok: true; app: GitHubApp; warnings: string[] }
  | { ok: false; reason: 'missing' | string };

export const expandHome = (p: string): string => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

function modeWarning(path: string): string | undefined {
  const mode = statSync(path).mode & 0o777;
  return mode & 0o077 ? `${path} is mode ${mode.toString(8)}: readable by group or others; chmod 600 it` : undefined;
}

export function loadGitHubAppFile(path: string): GitHubAppLoad {
  const file = expandHome(path);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: `${file}: ${(err as Error).message}` };
  }
  let parsed: GitHubAppFile;
  try {
    const r = appFileSchema.safeParse(JSON.parse(text));
    if (!r.success) {
      const issues = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return { ok: false, reason: `${file}: ${issues}` };
    }
    parsed = r.data;
  } catch (err) {
    return { ok: false, reason: `${file}: not JSON: ${(err as Error).message}` };
  }
  const keyFile = expandHome(parsed.privateKeyFile);
  let privateKey: string;
  try {
    privateKey = readFileSync(keyFile, 'utf8');
    createPrivateKey(privateKey);
  } catch (err) {
    return { ok: false, reason: `${keyFile} (privateKeyFile in ${file}): ${(err as Error).message}` };
  }
  const warnings = [modeWarning(file), modeWarning(keyFile)].filter((w): w is string => w !== undefined);
  return { ok: true, app: { ...parsed, privateKeyFile: keyFile, privateKey }, warnings };
}
