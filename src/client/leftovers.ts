// The leftovers of the layout before issue #1188 that the sweep does not judge (issue #1116, design.md "Leftovers a person
// decides"): what runs on a machine to list them, and to remove one a person chose to remove. Fixed POSIX sh scripts, run
// through the machine's own connection (this machine, ssh, or a client target's `/leftovers` and `/leftover-remove`), as the
// reap and the survey are (reap.ts). Imports nothing of hopper but its own directory.

import { UNPUSHED_SH } from './reap.ts';

/** How long the listing may take: a `du` cut off at 20 s, then git reads in each leftover. */
export const LEFTOVERS_TIMEOUT_MS = 120000;
/** How long a removal may take: one directory removed, which may be large. */
export const LEFTOVER_REMOVE_TIMEOUT_MS = 300000;

export const LEFTOVERS_DONE = 'hopper-leftovers-listed';
export const LEFTOVER_REMOVE_DONE = 'hopper-leftover-done';

/** The layout before's scratch area in a work tree (reap.ts `LAYOUT.oldScratch`). */
const OLD = '.hopper-scratch';

// $@ the work trees. For each whose `.hopper-scratch` is there: each dir in it but its shared dependencies (`deps`) and its
// mirrors' dir (`repos`) — a job's scratch dir, or anything else left there —, and, while one of those holds the layout
// back, each repository mirror `repos/<owner>/<name>.git`. One line each: `hopper-leftover <age s> <1: work not pushed>
// <worktrees that use it> <path>`. Then, where `timeout` is, one `du -skx` per work tree, cut off at 20 s:
// `hopper-leftover-du <KiB> <path>`. It only reads.
const LEFTOVERS_SCRIPT = [
  'now=$(date +%s); to=; command -v timeout >/dev/null 2>&1 && to="timeout 20";',
  ...UNPUSHED_SH,
  'age() { am=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null) && printf "%s" "$((now - am))"; };',
  // A dir's repositories (node_modules pruned): one holding work not pushed makes the dir hold it.
  'holds() { find "$1" -name node_modules -prune -o -name .git -print -prune 2>/dev/null | { while IFS= read -r hg; do held "${hg%/.git}" && exit 0; done; exit 1; }; };',
  // A mirror's worktrees that are still there: each a dir with its `.git`, never the mirror itself.
  'users() { git --git-dir="$1" worktree list --porcelain 2>/dev/null | sed -n "s/^worktree //p" | while IFS= read -r ut; do [ -e "$ut/.git" ] && printf "x\\n"; done | wc -l | tr -d " "; };',
  // Whether $1 is a leftover to list: a dir, no link; not the shared dependencies or the mirrors' dir; a mirror only while held.
  'ok() { [ -d "$1" ] && [ ! -L "$1" ] || return 1; case $1 in "$x"/deps|"$x"/repos) return 1;; "$x"/repos/*) [ -n "$held" ];; esac; };',
  `measure() { set --; for d in "$x"/* "$x"/repos/*/*.git; do ok "$d" && set -- "$@" "$d"; done; [ $# -gt 0 ] || return 0;`,
  `  $to du -skx "$@" 2>/dev/null | awk -F '\t' '$1 ~ /^[0-9]+$/ { k = $1; sub(/^[^\t]*\t/, ""); print "hopper-leftover-du " k " " $0 }'; };`,
  `for r in "$@"; do x=$r/${OLD}; [ -d "$x" ] && [ ! -L "$x" ] || continue;`,
  '  held=$(ls -A "$x" 2>/dev/null | grep -vx -e .gitignore -e deps -e repos);',
  '  for d in "$x"/* "$x"/repos/*/*.git; do ok "$d" || continue; a=$(age "$d") || continue; fu=0; fn=0;',
  // unpushed() sets u, so these are fu and fn.
  '    case $d in "$x"/repos/*) unpushed "$d" --branches && fu=1; fn=$(users "$d");; *) holds "$d" && fu=1;; esac;',
  '    printf "hopper-leftover %s %s %s %s\\n" "$a" "$fu" "$fn" "$d";',
  '  done;',
  '  [ -n "$to" ] && measure;',
  'done;',
  `printf "%s\\n" ${LEFTOVERS_DONE}`,
].map((l) => l.trim()).join(' ');

// $1 a leftover's path (`isLeftoverPath`). Removes that dir whatever it holds — a person decided so —, then the owner's dir
// of a mirror when it is empty, and then git forgets every worktree that is gone, in the work tree's repository, its
// workspace's checkouts and the mirrors left. Never a link. Says `hopper-leftover-gone` when it was not there, and
// `hopper-leftover-left <path>` when it is still there.
const REMOVE_SCRIPT = [
  'p=$1;',
  `case $p in */${OLD}/repos/*/*.git) w=\${p%/${OLD}/repos/*};; */${OLD}/*) w=\${p%/${OLD}/*};; *) exit 2;; esac;`,
  `x=$w/${OLD};`,
  'gone() { rm -rf "$1" 2>/dev/null; [ -e "$1" ] || return 0; chmod -R u+rwX "$1" 2>/dev/null; rm -rf "$1" 2>/dev/null; };',
  'if [ ! -e "$p" ] && [ ! -L "$p" ]; then printf "%s\\n" hopper-leftover-gone;',
  'elif [ -L "$p" ] || [ ! -d "$p" ]; then printf "hopper-leftover-left %s\\n" "$p";',
  'else gone "$p"; case $p in "$x"/repos/*) rmdir "${p%/*}" 2>/dev/null;; esac;',
  '  [ -e "$p" ] && printf "hopper-leftover-left %s\\n" "$p";',
  'fi;',
  'for g in "$w/.git" "$w"/workspace/*/.git "$x"/repos/*/*.git; do [ -d "$g" ] && [ ! -L "$g" ] && git --git-dir="$g" worktree prune 2>/dev/null; done;',
  `printf "%s\\n" ${LEFTOVER_REMOVE_DONE}`,
].map((l) => l.trim()).join(' ');

/** A work tree the listing may look in: absolute and one line. */
const isRoot = (path: unknown): path is string => typeof path === 'string' && path.startsWith('/') && !/[\n\0]/.test(path) && path.length <= 4096;

/**
 * A path a removal may take: absolute, one line, no `.` or `..` part, one `.hopper-scratch` part only, and either a dir right
 * in it (not `deps` or `repos`) or a mirror `repos/<owner>/<name>.git` in it.
 */
export function isLeftoverPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path.startsWith('/') || /[\n\0]/.test(path) || path.length > 4096) return false;
  const parts = path.slice(1).split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  const at = parts.indexOf(OLD);
  if (at < 0 || parts.lastIndexOf(OLD) !== at) return false;
  const rest = parts.slice(at + 1);
  if (rest.length === 1) return rest[0] !== 'deps' && rest[0] !== 'repos';
  return rest.length === 3 && rest[0] === 'repos' && rest[2]!.endsWith('.git') && rest[2] !== '.git';
}

/** The argv that lists the leftovers in `roots`. */
export const leftoversArgv = (roots: readonly string[]): string[] => ['sh', '-c', LEFTOVERS_SCRIPT, 'sh', ...roots];

/** The argv that removes the leftover at `path` (`isLeftoverPath`). */
export const leftoverRemoveArgv = (path: string): string[] => ['sh', '-c', REMOVE_SCRIPT, 'sh', path];

/** One leftover the listing found: a dir right in `.hopper-scratch`, or a repository mirror in it. */
export interface ListedLeftover {
  path: string;
  kind: 'scratch' | 'mirror';
  ageMs: number;
  /** It holds work not pushed: a change, or a commit no remote has. */
  unpushed: boolean;
  /** A mirror's: the worktrees that still use it. */
  users?: number;
  /** Its size; absent, not measured (no `timeout` there, a slow disk). */
  bytes?: number;
}

/** What a finished listing found. Undefined when it did not finish. */
export function readLeftovers(stdout: string): ListedLeftover[] | undefined {
  const lines = stdout.split('\n').map((l) => l.trimEnd());
  if (!lines.includes(LEFTOVERS_DONE)) return undefined;
  const sizes = new Map<string, number>();
  for (const l of lines) {
    const m = /^hopper-leftover-du (\d+) (\/.*)$/.exec(l);
    if (m) sizes.set(m[2]!, Number(m[1]) * 1024);
  }
  const out: ListedLeftover[] = [];
  for (const l of lines) {
    const m = /^hopper-leftover (\d+) ([01]) (\d+) (\/.*)$/.exec(l);
    if (!m || !isLeftoverPath(m[4])) continue;
    const path = m[4];
    const kind = /\/\.hopper-scratch\/repos\/[^/]+\/[^/]+\.git$/.test(path) ? 'mirror' : 'scratch';
    const bytes = sizes.get(path);
    out.push({ path, kind, ageMs: Number(m[1]) * 1000, unpushed: m[2] === '1', ...(kind === 'mirror' ? { users: Number(m[3]) } : {}), ...(bytes !== undefined ? { bytes } : {}) });
  }
  return out;
}

/** How a finished removal ended: removed, not there, or still there. Undefined when it did not finish. */
export function readLeftoverRemoval(stdout: string): 'removed' | 'gone' | 'left' | undefined {
  const lines = stdout.split('\n').map((l) => l.trimEnd());
  if (!lines.includes(LEFTOVER_REMOVE_DONE)) return undefined;
  if (lines.some((l) => l.startsWith('hopper-leftover-left '))) return 'left';
  return lines.includes('hopper-leftover-gone') ? 'gone' : 'removed';
}

/** The argv a `/leftovers` or `/leftover-remove` body asks for; else why it is refused. */
export function leftoverArgvOf(path: '/leftovers' | '/leftover-remove', body: unknown): string[] | string {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { roots?: unknown; path?: unknown };
  if (path === '/leftovers') {
    if (!Array.isArray(b.roots) || b.roots.length > 256 || !b.roots.every(isRoot)) return 'roots must be at most 256 absolute paths';
    return leftoversArgv(b.roots);
  }
  if (!isLeftoverPath(b.path)) return 'path must be a leftover in a work tree\'s .hopper-scratch';
  return leftoverRemoveArgv(b.path);
}
