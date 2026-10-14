// The client release (design.md "Client releases", issues #70, #545): the hopper client as one versioned
// unit. The hopper releases the client files of the install it runs from; a client target runs the
// release in its install dir. A release is its files, its manifest — each file's name and SHA-256 — and an
// id, the first 16 hex of a SHA-256 over the manifest: the same files are always the same id and nothing
// but the files decides it. No list of file names is fixed here: the manifest the release carries names
// its files, so a release may add, remove or rename them. The hopper loads its release onto a client
// running another (server.ts `POST /load`, signed like every call, the body's hash in the signature); the
// client checks it whole against its manifest before writing a byte, writes it beside its install dir and
// swaps it in, keeping the one before as `<dir>.prev`.
// Imports nothing of hopper: it is installed on the target as plain files.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A client file's name: a plain TypeScript file in the install dir, never a path. */
const CLIENT_FILE = /^[a-z0-9][a-z0-9-]*\.ts$/;
/** The file whatever runs the client starts. */
const ENTRY = 'main.ts';
const MAX_FILES = 64;

export interface ClientRelease {
  /** 16 hex: the manifest's. */
  id: string;
  /** File name → the SHA-256 (hex) of its content. */
  manifest: Record<string, string>;
  /** File name → content. */
  files: Record<string, string>;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

function manifestId(manifest: Record<string, string>): string {
  const h = createHash('sha256');
  for (const name of Object.keys(manifest).sort()) h.update(`${name}\0${manifest[name]}\n`);
  return h.digest('hex').slice(0, 16);
}

/** The release these files make: their manifest and its id. */
export function releaseOf(files: Record<string, string>): ClientRelease {
  const manifest = Object.fromEntries(Object.keys(files).sort().map((name) => [name, sha256(files[name]!)]));
  return { id: manifestId(manifest), manifest, files };
}

/** The release in a directory: every client file in it, read now. */
export function readRelease(dir: string): ClientRelease {
  const names = readdirSync(dir).filter((name) => CLIENT_FILE.test(name));
  return releaseOf(Object.fromEntries(names.map((name) => [name, readFileSync(join(dir, name), 'utf8')])));
}

/** The release, when it is whole — every file the manifest's, the manifest the id's; else why not. */
export function checkRelease(v: unknown): ClientRelease | string {
  if (typeof v !== 'object' || v === null) return 'a release must be {id, manifest, files}';
  const { id, manifest, files } = v as { id?: unknown; manifest?: unknown; files?: unknown };
  if (typeof id !== 'string' || typeof manifest !== 'object' || manifest === null || typeof files !== 'object' || files === null) return 'a release must be {id, manifest, files}';
  const m = manifest as Record<string, unknown>;
  const f = files as Record<string, unknown>;
  const names = Object.keys(m);
  if (names.length > MAX_FILES) return `a release has at most ${MAX_FILES} files`;
  const bad = names.find((n) => !CLIENT_FILE.test(n));
  if (bad !== undefined) return `the release's file name ${JSON.stringify(bad)} is not a plain client file name`;
  if (!names.includes(ENTRY)) return `the release has no ${ENTRY}`;
  const unlisted = Object.keys(f).find((n) => !Object.hasOwn(m, n));
  if (unlisted !== undefined) return `the release's file ${JSON.stringify(unlisted)} is not in its manifest`;
  for (const name of names) {
    if (!Object.hasOwn(f, name)) return `the release's manifest names ${name}, which it does not carry`;
    if (typeof f[name] !== 'string') return 'every file of the release must be text';
    if (m[name] !== sha256(f[name])) return `the release's ${name} is not its manifest's`;
  }
  const want = manifestId(m as Record<string, string>);
  if (want !== id) return `the release's id ${id} is not its manifest's (${want})`;
  return { id, manifest: m as Record<string, string>, files: f as Record<string, string> };
}

/** Writes the release to `<dir>.next`, then swaps it in: `<dir>` → `<dir>.prev`, `<dir>.next` → `<dir>`. */
export function installRelease(dir: string, release: ClientRelease): void {
  const next = `${dir}.next`;
  const prev = `${dir}.prev`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true, mode: 0o755 });
  for (const [name, text] of Object.entries(release.files)) writeFileSync(join(next, name), text, { mode: 0o644 });
  rmSync(prev, { recursive: true, force: true });
  if (existsSync(dir)) renameSync(dir, prev);
  renameSync(next, dir);
}
