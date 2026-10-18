// The sentinel .env of test/scripts/no-dotenv.test.ts (issue #1960): no install, update or run path reads or writes a
// .env (issues #894, #970). A sentinel .env goes in each folder a path works in: its every value is SENTINEL, so a path
// that reads it carries SENTINEL into its output, its calls or a file; and its access time is set before its change
// time, so a read moves the access time on a file system that keeps it (relatime, the default). `breaches` says what a
// run did to the sentinels, which .env it made, and which file holds a secret the run was given at launch.
import { readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';

export const SENTINEL = 'dotenv-sentinel-0d0e0f0e0d0e0f0e';
const TEXT = ['HOPPER_MASTER_KEY', 'HOPPER_DATABASE_URL', 'HOPPER_IMAGE', 'HOPPER_PUBLIC_URL', 'HOPPER_BIND', 'HOPPER_LAN_NAMES',
  'HOPPER_TUNNEL_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'COMPOSE_PROFILES', 'COMPOSE_PROJECT_NAME']
  .map((k) => `${k}=${SENTINEL}\n`).join('');
// The stub logs, tool folders and launch credentials the harnesses make: the test's own, never a file a path writes.
const OWN = new Set(['.calls', '.bin', '.files', '.creds', 'log']);

interface Planted { path: string; atimeMs: number; mtimeMs: number }

export interface Sentinels {
  /** Whether this file system moves a file's access time on a read: when not, only the values show a read. */
  atime: boolean;
  planted: Planted[];
}

/** A sentinel .env in each folder. */
export function plant(...dirs: string[]): Sentinels {
  const planted = dirs.map((d) => {
    const path = join(d, '.env');
    writeFileSync(path, TEXT, { mode: 0o600 });
    const s = statSync(path);
    utimesSync(path, new Date(s.mtimeMs - 3_600_000), new Date(s.mtimeMs));
    const t = statSync(path);
    return { path, atimeMs: t.atimeMs, mtimeMs: t.mtimeMs };
  });
  return { atime: movesAtime(dirs[0] ?? '.'), planted };
}

function movesAtime(dir: string): boolean {
  const probe = join(dir, '.atime-probe');
  writeFileSync(probe, 'x');
  const s = statSync(probe);
  utimesSync(probe, new Date(s.mtimeMs - 3_600_000), new Date(s.mtimeMs));
  const before = statSync(probe).atimeMs;
  spawnSync('cat', [probe]);
  return statSync(probe).atimeMs !== before;
}

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (OWN.has(name) || name === '.atime-probe') continue;
    const p = join(dir, name);
    const s = statSync(p, { throwIfNoEntry: false });
    if (s?.isDirectory()) files(p, out);
    else if (s?.isFile()) out.push(p);
  }
  return out;
}

/**
 * What a run broke: a sentinel read, changed or removed; a .env it made under `roots`; SENTINEL in `seen` (its output and
 * calls) or in a file it wrote; a file under `roots` that holds one of `secrets`, given at launch.
 */
export function breaches(s: Sentinels, o: { roots: string[]; seen: string[]; secrets?: string[] }): string[] {
  const out: string[] = [];
  const planted = new Set(s.planted.map((p) => p.path));
  for (const p of s.planted) {
    const now = statSync(p.path, { throwIfNoEntry: false });
    if (!now) { out.push(`${p.path}: removed`); continue; }
    if (s.atime && now.atimeMs !== p.atimeMs) out.push(`${p.path}: read`);
    if (now.mtimeMs !== p.mtimeMs || readFileSync(p.path, 'utf8') !== TEXT) out.push(`${p.path}: changed`);
  }
  for (const f of o.roots.flatMap((r) => files(r))) {
    if (planted.has(f)) continue;
    if (basename(f) === '.env') out.push(`${f}: a .env made`);
    const text = readFileSync(f);
    if (text.includes(SENTINEL)) out.push(`${f}: holds a value of a sentinel .env`);
    for (const secret of o.secrets ?? []) if (text.includes(secret)) out.push(`${f}: holds a secret given at launch`);
  }
  if (o.seen.some((t) => t.includes(SENTINEL))) out.push('the output or a call holds a value of a sentinel .env');
  return out;
}
