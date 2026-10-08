// Dependencies shared by a repository's job worktrees (issue #410, design.md "Work tree" → "Shared
// dependencies"): each job ran its own `npm ci`, about 400 MB, for as long as it ran. After the job
// worktree is made, the pane's shell links its node_modules to the dependencies installed for its
// lockfile, `<work tree>/.hopper-scratch/deps/<lockfile's git hash>/node_modules`, installing them there
// first when no job has: `npm ci --prefer-offline` in the job's worktree, then moved into place, under a
// lock per work tree, so concurrent jobs with one lockfile install once. A lockfile no job has had gets
// its own entry: one in use never changes under a job. An entry no job worktree links to, unused for the
// scratch age, is removed. Workspaces (their node_modules links into the repository) get an install of
// their own. The reap removes the link, never what it points to (src/client/server.ts).

import { shellQuote } from '../ssh.ts';

/** What the command prints, followed by its outcome. */
export const DEPS_MARK = 'hopper-deps-';

/**
 * linked: to dependencies another job installed; installed: installed for this lockfile and linked; own: an
 * install of the job's own (workspaces); kept: the worktree already has node_modules (a run before);
 * none: no package-lock.json, or no npm; failed: npm ci failed — the job goes on and installs as it needs.
 */
export type DepsOutcome = 'linked' | 'installed' | 'own' | 'kept' | 'none' | 'failed';
const OUTCOMES: readonly DepsOutcome[] = ['linked', 'installed', 'own', 'kept', 'none', 'failed'];

// $1 the work tree, $2 the job worktree, $3 minutes unused before an entry nothing links to is removed.
// Printed as two words, so the command's own echo never reads as its outcome.
const SCRIPT = [
  't=$1; w=$2; age=$3;',
  'say() { printf "hopper-%s-%s\\n" deps "$1"; };',
  'ci() { (cd "$w" && npm ci --prefer-offline --no-audit --no-fund); };',
  '[ -f "$w/package-lock.json" ] && command -v npm >/dev/null 2>&1 || { say none; exit 0; };',
  '[ -e "$w/node_modules" ] && { say kept; exit 0; };',
  'if grep -q \'"workspaces"\' "$w/package.json" 2>/dev/null; then if ci; then say own; else say failed; fi; exit 0; fi;',
  'h=$(git hash-object "$w/package-lock.json") || { say failed; exit 0; };',
  'deps="$t/.hopper-scratch/deps"; d="$deps/$h"; mkdir -p "$deps" || { say failed; exit 0; };',
  'exec 9>"$deps/.lock"; command -v flock >/dev/null 2>&1 && flock 9;',
  'how=linked;',
  'if [ ! -d "$d/node_modules" ]; then',
  '  ci || { say failed; exit 0; };',
  '  rm -rf "$d.part" && mkdir -p "$d.part" && mv "$w/node_modules" "$d.part/node_modules" && mv "$d.part" "$d" || { say failed; exit 0; };',
  '  how=installed;',
  'fi;',
  'touch "$d"; ln -s "$d/node_modules" "$w/node_modules" || { say failed; exit 0; };',
  // Entries no job worktree links to, unused for the scratch age.
  'for o in "$deps"/*; do',
  '  [ -d "$o" ] && [ "$o" != "$d" ] || continue;',
  '  [ -n "$(find "$t/.hopper-scratch" -mindepth 3 -maxdepth 3 -name node_modules -type l -lname "$o/*" 2>/dev/null | head -n 1)" ] && continue;',
  '  [ -n "$(find "$o" -maxdepth 0 -mmin "+$age" 2>/dev/null)" ] && rm -rf "$o";',
  'done;',
  'say "$how"',
].map((l) => l.trim()).join(' ');

/** The command typed into the pane's shell, in the job worktree: any shell, since it hands the script to sh. */
export function shareDepsCommand(workTree: string, jobWorktree: string, maxAgeHours: number): string {
  const minutes = Math.max(1, Math.round(maxAgeHours * 60));
  return `sh -c ${shellQuote(SCRIPT)} sh ${shellQuote(workTree.replace(/(.)\/+$/, '$1'))} ${shellQuote(jobWorktree)} ${minutes}`;
}

/** The outcome the command printed on the screen, if it has. */
export function depsOutcome(screen: string): DepsOutcome | undefined {
  const last = screen.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(DEPS_MARK)).at(-1)?.slice(DEPS_MARK.length);
  return (OUTCOMES as readonly string[]).includes(last ?? '') ? last as DepsOutcome : undefined;
}
