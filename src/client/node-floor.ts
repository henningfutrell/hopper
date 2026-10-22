// The patched Node floor (issue #2479): the lowest version of each Node line with the October 21, 2026 security release
// (a Brotli decoder RCE, TLS hostname-check bypasses, DNS name truncation). package.json `engines` says the same. The
// hopper and the client say so at start below it, a machine's resources carry its Node version (resources.ts), and the
// Machines page warns of a machine below it. Imports nothing of hopper: a client target runs it as a plain file.

/** The lowest patched version of each line that has one, oldest line first. */
export const NODE_FLOORS = [[24, 22, 1], [26, 12, 1]] as const;

const text = (v: readonly number[]): string => v.join('.');

/** The floor a Node version (`v26.8.2`) is below: its own line's, else the next patched line's. Undefined: patched, or not read. */
export function nodeFloorOf(version: string): string | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!m) return undefined;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const newest = NODE_FLOORS[NODE_FLOORS.length - 1]!;
  if (major > newest[0]) return undefined;
  const floor = NODE_FLOORS.find((f) => f[0] >= major)!;
  if (floor[0] > major) return text(floor);
  return minor > floor[1] || (minor === floor[1] && patch >= floor[2]) ? undefined : text(floor);
}

/** The line to say at start when this Node is below the floor; undefined when it is patched. */
export function nodeWarning(version: string = process.version): string | undefined {
  const floor = nodeFloorOf(version);
  return floor ? `Node ${version} lacks the October 21, 2026 security release: update it to ${floor} or later (https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)` : undefined;
}

// Run as a file (the image builds, issue #2479): exits 1 below the floor, so no image is built on unpatched Node.
if (import.meta.main) {
  const warning = nodeWarning();
  if (warning) { process.stderr.write(`${warning}\n`); process.exit(1); }
  process.stdout.write(`Node ${process.version} is at or above the patched floor\n`);
}
