// The client release (design.md "Client releases", issue #70): the hopper client as one versioned
// unit. The hopper releases the client files of the install it runs from; a client target runs the
// release in its install dir. A release is its files and an id — the first 16 hex of a SHA-256 over
// every file name and content, in CLIENT_FILES order — so the same files are always the same id and
// nothing but the files decides it. The hopper loads its release onto a client running another
// (server.ts `POST /load`, signed like every call); the client checks it whole before writing a byte,
// writes it beside its install dir and swaps it in, keeping the one before as `<dir>.prev`.
// Imports nothing of job-hopper: it is installed on the target as plain files.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every file of the hopper client, and nothing else: relay.ts runs on the hopper's machine. */
export const CLIENT_FILES = ['main.ts', 'release.ts', 'server.ts', 'signature.ts', 'ssh-options.ts', 'tunnel.ts'] as const;

export interface ClientRelease {
  /** 16 hex: the files' content. */
  id: string;
  /** File name (one of CLIENT_FILES) → content. */
  files: Record<string, string>;
}

export function releaseId(files: Record<string, string>): string {
  const h = createHash('sha256');
  for (const name of CLIENT_FILES) h.update(`${name}\0${files[name] ?? ''}\0`);
  return h.digest('hex').slice(0, 16);
}

/** The release in a directory: its client files, read now. Throws when one is missing. */
export function readRelease(dir: string): ClientRelease {
  const files = Object.fromEntries(CLIENT_FILES.map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
  return { id: releaseId(files), files };
}

/** The release, when it is whole and its id is its files'; else why not. */
export function checkRelease(v: unknown): ClientRelease | string {
  if (typeof v !== 'object' || v === null) return 'a release must be {id, files}';
  const { id, files } = v as { id?: unknown; files?: unknown };
  if (typeof id !== 'string' || typeof files !== 'object' || files === null) return 'a release must be {id, files}';
  const names = Object.keys(files).sort();
  const want = [...CLIENT_FILES].sort();
  if (names.length !== want.length || names.some((n, i) => n !== want[i])) return `the release's files must be exactly ${want.join(', ')}`;
  if (Object.values(files).some((c) => typeof c !== 'string')) return 'every file of the release must be text';
  const f = files as Record<string, string>;
  if (releaseId(f) !== id) return `the release's id ${id} is not its files' (${releaseId(f)})`;
  return { id, files: f };
}

/** Writes the release to `<dir>.next`, then swaps it in: `<dir>` → `<dir>.prev`, `<dir>.next` → `<dir>`. */
export function installRelease(dir: string, release: ClientRelease): void {
  const next = `${dir}.next`;
  const prev = `${dir}.prev`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true, mode: 0o755 });
  for (const name of CLIENT_FILES) writeFileSync(join(next, name), release.files[name]!, { mode: 0o644 });
  rmSync(prev, { recursive: true, force: true });
  if (existsSync(dir)) renameSync(dir, prev);
  renameSync(next, dir);
}
