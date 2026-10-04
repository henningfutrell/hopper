// The install directory: install.json (what it was built from), and the swap of a next install (built beside it)
// into its place. The old install stays beside it as `<appDir>.prev` until the next swap.
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { InstallInfo } from '../domain/types.ts';

export const INSTALL_FILE = 'install.json';

const installSchema = z.object({
  repo: z.string().min(1), branch: z.string().min(1), commit: z.string().regex(/^[0-9a-f]{40}$/), installedAt: z.string(),
});

export type InstallRead = { ok: true; info: InstallInfo } | { ok: false; reason: string };

export function readInstallInfo(appDir: string): InstallRead {
  const path = join(appDir, INSTALL_FILE);
  if (!existsSync(path)) return { ok: false, reason: `no ${path}: this copy was not installed by scripts/install.sh, so it does not know its repository and commit` };
  try {
    const parsed = installSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (parsed.success) return { ok: true, info: parsed.data };
    return { ok: false, reason: `${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  } catch (e) {
    return { ok: false, reason: `${path}: ${(e as Error).message}` };
  }
}

export const nextDirOf = (appDir: string): string => `${appDir}.next`;
export const prevDirOf = (appDir: string): string => `${appDir}.prev`;

/** `<appDir>.next` → `<appDir>`, the old one → `<appDir>.prev`. A failed second rename puts the old one back. */
export function swapInstall(appDir: string): void {
  const prev = prevDirOf(appDir);
  rmSync(prev, { recursive: true, force: true });
  renameSync(appDir, prev);
  try {
    renameSync(nextDirOf(appDir), appDir);
  } catch (e) {
    renameSync(prev, appDir);
    throw e;
  }
}
