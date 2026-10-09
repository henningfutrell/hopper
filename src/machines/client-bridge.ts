// The bridge release (design.md "Client releases" → "Clients with a fixed file list", issue #545). A client
// released before manifests checks a load against a list of file names fixed in its own release.ts, and
// its id against a hash over exactly those names: it refuses every release with other files, so it could
// never load one that adds a file. The bridge is a release it believes — exactly its names, the id it
// computes — whose main.ts carries the hopper's release. Loaded, the old client restarts into the bridge;
// the bridge writes the hopper's release over the install dir (the release before the bridge stays as
// `<dir>.prev`) and exits 75, so whatever runs the client (its unit, a box's entrypoint, the loop on a
// Windows computer) starts the hopper's release. Built here, never shipped in the client's directory: it
// is not a client file.
import { createHash } from 'node:crypto';
import type { ClientRelease } from '../client/release.ts';

/** A release as a client with a fixed file list takes it: its files and the id it computes. */
export interface FixedListRelease { id: string; files: Record<string, string> }

/** The id a fixed-list client computes: a SHA-256 over every name of its list, in order, and its content. */
function fixedListId(names: readonly string[], files: Record<string, string>): string {
  const h = createHash('sha256');
  for (const name of names) h.update(`${name}\0${files[name] ?? ''}\0`);
  return h.digest('hex').slice(0, 16);
}

/** Every file of the bridge but main.ts: placeholders, the old client's list filled. */
const PLACEHOLDER = '// hopper client bridge (issue #545): main.ts writes the hopper\'s client release over this directory.\nexport {};\n';

/** The bridge's main.ts: writes `release` over its own directory, then exits 75; on a failure, puts back the release before it. */
function bridgeMain(release: ClientRelease): string {
  return `// hopper client bridge (issue #545): the client before this one checked a fixed list of file names, so it
// could load only this. Started, it writes the hopper's client release ${release.id} over this directory and
// exits 75, so whatever runs the client starts that release. On a failure it puts back the release before it.
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const release = ${JSON.stringify({ id: release.id, files: release.files })};
const dir = dirname(fileURLToPath(import.meta.url));
const next = dir + '.next';
const prev = dir + '.prev';
try {
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true, mode: 0o755 });
  for (const [name, text] of Object.entries(release.files)) writeFileSync(join(next, name), text, { mode: 0o644 });
  rmSync(dir, { recursive: true, force: true });
  renameSync(next, dir);
} catch (e) {
  process.stderr.write('hopper-client: unpacking release ' + release.id + ' failed: ' + (e instanceof Error ? e.message : String(e)) + '\\n');
  if (existsSync(prev)) {
    rmSync(dir, { recursive: true, force: true });
    renameSync(prev, dir);
    process.stderr.write('hopper-client: put back the release before the bridge; restarting to run it\\n');
  }
  process.exit(existsSync(join(dir, 'main.ts')) ? 75 : 1);
}
process.stdout.write('hopper-client: unpacked release ' + release.id + ' into ' + dir + '; restarting to run it\\n');
process.exit(75);
`;
}

/** The bridge to `release` for a client whose fixed list is `names`. */
export function bridgeRelease(release: ClientRelease, names: readonly string[]): FixedListRelease {
  const files = Object.fromEntries(names.map((name) => [name, name === 'main.ts' ? bridgeMain(release) : PLACEHOLDER]));
  return { id: fixedListId(names, files), files };
}

const FIXED_LIST = /the release's files must be exactly ((?:[a-z0-9][a-z0-9-]*\.ts)(?:, [a-z0-9][a-z0-9-]*\.ts)*)/;

/** The fixed list a client named when it refused a load; undefined when the refusal names none, or none with a main.ts. */
export function fixedNamesOf(message: string): string[] | undefined {
  const names = FIXED_LIST.exec(message)?.[1]?.split(', ');
  return names?.includes('main.ts') ? names : undefined;
}
