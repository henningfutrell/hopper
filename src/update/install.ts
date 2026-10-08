// The install directory: install.json (what it was built from), and the swap of a next install (built beside it)
// into its place. The old install stays beside it as `<appDir>.prev` until the next swap. An image carries an
// install.json too, written at its build (issue #409); one may lack a field its build was not given.
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { InstallInfo } from '../domain/types.ts';

export const INSTALL_FILE = 'install.json';

const installSchema = z.object({
  // An install.json from before issue #409 names no kind: every one then was an install.
  kind: z.enum(['install', 'image']).default('install'),
  repo: z.string().min(1).optional(), branch: z.string().min(1).optional(),
  commit: z.string().regex(/^[0-9a-f]{40}$/).optional(), installedAt: z.string().optional(),
});

/** What each field is called in the note on what a build lacks. */
const FIELD_NAMES: Record<Exclude<keyof InstallInfo, 'kind'>, string> = { repo: 'repository', branch: 'branch', commit: 'commit', installedAt: 'build time' };

/** `known`: the fields install.json has, whole (`ok`) or not. */
export type InstallRead = { ok: true; info: InstallInfo; known: InstallInfo } | { ok: false; reason: string; known: Partial<InstallInfo> };

export function readInstallInfo(appDir: string): InstallRead {
  const path = join(appDir, INSTALL_FILE);
  if (!existsSync(path)) return { ok: false, known: {}, reason: `no ${path}: this copy was built by neither scripts/install.sh nor scripts/build-image.sh, so it does not know its repository and commit` };
  let parsed;
  try {
    parsed = installSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    return { ok: false, known: {}, reason: `${path}: ${(e as Error).message}` };
  }
  if (!parsed.success) return { ok: false, known: {}, reason: `${path}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  const known = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) as Partial<InstallInfo>;
  const missing = (Object.keys(FIELD_NAMES) as (keyof typeof FIELD_NAMES)[]).filter((k) => known[k] === undefined);
  if (missing.length) {
    const how = known.kind === 'image' ? 'build the image with scripts/build-image.sh' : 'install with scripts/install.sh';
    return { ok: false, known, reason: `this build does not know its ${missing.map((k) => FIELD_NAMES[k]).join(', ')}: ${path} lacks it (${how})` };
  }
  const info = known as InstallInfo;
  return { ok: true, info, known: info };
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
