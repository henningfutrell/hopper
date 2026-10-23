// The cache clear (issue #2494, design.md "Hopper's own disk use" → "Part 10"): what runs on a machine to empty the caches
// of the kinds over their cap. A fixed POSIX sh script, run through the machine's own connection (this machine, ssh, or a
// client target's `/caches`), as the reap and the prune are (reap.ts, prune.ts). It removes only the fixed places under
// the home the survey measures (CACHE_DIRS), never a link, and nothing else. Imports nothing of hopper but its own
// directory.

import type { CappedKind, Cleared } from '../domain/cache-caps.ts';
import { CACHE_DIRS } from './reap.ts';

/** The kinds a clear takes: each kind of CACHE_DIRS (src/domain/cache-caps.ts holds the same, which test/client/caches.test.ts checks). */
export const CLEARED_KINDS = [...new Set(CACHE_DIRS.map(([kind]) => kind))] as CappedKind[];

/** How long a clear may take: each removal is cut off at 120 s where `timeout` is. */
export const CACHES_TIMEOUT_MS = 300000;
export const CACHES_DONE = 'hopper-caches-done';

// The Gradle daemons a job left (issue #2489) hold the Gradle caches open: stopped first. The pattern's brackets keep pkill
// from matching this script's own command line.
const GRADLE_DAEMONS = 'command -v pkill >/dev/null 2>&1 && pkill -u "$(id -u)" -f "org[.]gradle[.]launcher[.]daemon[.]bootstrap[.]GradleDaem[o]n" >/dev/null 2>&1;';

// $@ the kinds to clear. `clear <kind> <place>`: the place under the home, when it is a dir and no link, made writable (Go
// makes its module cache read-only) and removed; it prints `hopper-cache-cleared|<kind>|<path>` once it is gone.
const CACHES_SCRIPT = [
  'case $HOME in ""|/) exit 2;; esac; to=; command -v timeout >/dev/null 2>&1 && to="timeout 120";',
  'clear() { p=$HOME/$2; [ -d "$p" ] && [ ! -L "$p" ] || return 0; [ "$1" = go ] && $to chmod -R u+w "$p" 2>/dev/null;',
  '  $to rm -rf "$p" 2>/dev/null; [ -e "$p" ] || printf "hopper-cache-cleared|%s|%s\\n" "$1" "$p"; };',
  'for k do case $k in',
  ...CLEARED_KINDS.map((kind) => `  ${kind}) ${kind === 'gradle' ? GRADLE_DAEMONS : ''} ${CACHE_DIRS.filter(([k]) => k === kind).map(([, rel]) => `clear ${kind} ${rel}`).join('; ')};;`),
  '  *) ;;',
  'esac; done;',
  `printf "%s\\n" ${CACHES_DONE}`,
].map((l) => l.trim()).join(' ');

/** The argv that clears the caches of the kinds. */
export const cachesArgv = (kinds: readonly CappedKind[]): string[] => ['sh', '-c', CACHES_SCRIPT, 'sh', ...kinds];

/** What a finished clear removed. Undefined when it did not finish. */
export function readCaches(stdout: string): Cleared | undefined {
  const lines = stdout.split('\n').map((l) => l.trimEnd());
  if (!lines.includes(CACHES_DONE)) return undefined;
  const removed: Cleared['removed'] = [];
  for (const l of lines) {
    const [mark, kind, ...path] = l.split('|');
    const p = path.join('|');
    if (mark === 'hopper-cache-cleared' && CLEARED_KINDS.includes(kind as CappedKind) && p.startsWith('/')) removed.push({ kind: kind as CappedKind, path: p });
  }
  return { removed };
}

/** The argv a `/caches` body asks for; else why it is refused. */
export function cachesArgvOf(body: unknown): string[] | string {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { kinds?: unknown };
  if (!Array.isArray(b.kinds) || b.kinds.length === 0 || !b.kinds.every((k) => CLEARED_KINDS.includes(k as CappedKind))) {
    return `kinds must be one or more of ${CLEARED_KINDS.join(', ')}`;
  }
  return cachesArgv([...new Set(b.kinds as CappedKind[])]);
}
