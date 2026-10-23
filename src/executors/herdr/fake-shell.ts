// What the fake herdr's pane shell prints for each command the executor types into it (fake-client.ts):
// the scratch command, the job's scope (issue #410), the job's container runtime and sandbox (issue #1295), the job worktree (issue #379), shared dependencies
// (issue #410), and any command ending in a split printf. Pure: the options and whether the shell already
// runs in the job's scope decide it.

import { TERMINAL_LINE_MAX } from './client.ts';
import { EXIT_CODE_COMMAND, EXIT_CODE_MARK, OOM_KILLS_MARK } from './exited.ts';

export type FakeRestore = 'restored' | 'partly' | 'kept' | 'failed' | 'no-way';

/** What the next restore says: the first of a list, the last one kept. */
function nextRestore(o: FakeShellOptions): string[] {
  const r = Array.isArray(o.restore) ? (o.restore.length > 1 ? o.restore.shift()! : o.restore[0]) : o.restore;
  if (r === 'partly') return ['hopper: left out src/a.ts', 'hopper: kept the whole patch in /w/.git/worktrees/j/hopper-checkpoint.patch', 'hopper-restore-partly'];
  return r === 'no-way' ? ['hopper: the job has no way to the hopper: HOPPER_URL is not set', 'hopper-restore-failed'] : [`hopper-restore-${r ?? 'restored'}`];
}

/** What the shell does with a typed command: the lines it prints, and whether it now runs in the job's scope. */
export interface ShellSaid { lines: string[]; scoped?: true }

export interface FakeShellOptions {
  scopes?: boolean;
  deps?: string;
  repositories?: string[];
  origins?: Record<string, string>;
  worktreeFails?: boolean;
  unusableDirs?: string[];
  /** What a checkpoint restore says (issue #921); `no-way`: it fails with no way to the hopper (issue #2316). A list: one per restore, the last kept. */
  restore?: FakeRestore | FakeRestore[];
  /** What the job's container runtime setup says (issue #1295); default none: the fake machine has no podman. */
  runtime?: 'own' | 'none' | 'failed' | 'silent';
  /** What the job's sandbox setup says (issue #1295); default none: the fake machine has no bubblewrap. */
  sandbox?: 'on' | 'none' | 'failed';
  /** The status Claude exited with, as the shell says it after Claude (issue #2432); default 0. */
  claudeExitCode?: number;
  /** The OOM kills in the job's scope, as the shell reads them after Claude (issue #2498); default 0. */
  oomKills?: number;
}

/** A typed command longer than ECHO_MAX echoes only its first ECHO_SHOWN characters, as a terminal's screen scrolls the rest off. */
const ECHO_MAX = 2000;
const ECHO_SHOWN = 100;

/**
 * The shell's echo of a typed command. A long one (the job's container runtime set-up, issue #1295, is over 5 KB) shows
 * only its start: a real pane's screen is a bounded number of rows, and a full echo kept on the fake screen makes each
 * poll of a long run scan it again.
 */
export function echoOf(command: string): string {
  return command.length > ECHO_MAX ? `$ ${command.slice(0, ECHO_SHOWN)}…` : `$ ${command}`;
}

export function shellSays(command: string, o: FakeShellOptions, scoped: boolean): ShellSaid {
  // A shell with no line editor (dash, a box's sh) reads a line the terminal kept: one past its limit is cut, its quotes
  // left open, and it runs nothing (issue #2234). The fake's shell is that strict, so a command too long fails a test.
  if (command.length > TERMINAL_LINE_MAX) return { lines: ['> '] };
  // The job's scope (job-scope.ts): with systemd the shell is replaced by one in the scope and prints
  // nothing; without, it says none. Asked where it runs, it says whether that is the scope.
  if (command.includes('exec systemd-run --user --scope')) return o.scopes ? { lines: [], scoped: true } : { lines: ['hopper-scope-none'] };
  if (command.startsWith('case "$(cat /proc/self/cgroup')) return { lines: [`hopper-scope-${scoped ? 'entered' : 'outside'}`] };
  // Restoring a checkpoint (issue #921, checkpoint.ts): its outcome, as two printf words.
  if (command.startsWith('o=$(sh -c ') && command.includes(' hopper-restore ')) return { lines: nextRestore(o) };
  // The shell's status of Claude, once Claude exited (issue #2432).
  if (command === EXIT_CODE_COMMAND) return { lines: [`${EXIT_CODE_MARK}${o.claudeExitCode ?? 0}`] };
  // The OOM kills in the job's scope (issue #2498): only a shell in the scope reads them.
  if (command.startsWith("g=$(sed -n 's/^0:://p' /proc/self/cgroup")) return { lines: [`${OOM_KILLS_MARK}${scoped ? o.oomKills ?? 0 : 'none'}`] };
  // The job's sandbox (src/client/job-sandbox.ts): its outcome, as two printf words.
  if (command.startsWith('o=$(sh -c ') && command.includes(' hopper-sandbox ')) return { lines: [`hopper-sandbox-${o.sandbox ?? 'none'}`] };
  // The job's container runtime guards, its first step (issue #2234).
  if (command.startsWith('o=$(sh -c ') && command.includes(' hopper-guards ')) return { lines: ['hopper-guards-written'] };
  // The job's own container runtime (src/client/job-runtime.ts): its outcome, as two printf words; silent says nothing.
  if (command.startsWith('o=$(sh -c ') && command.includes(' hopper-runtime ')) return { lines: o.runtime === 'silent' ? [] : [`hopper-runtime-${o.runtime ?? 'none'}`] };
  // Sharing dependencies (shared-deps.ts): its outcome.
  if (command.startsWith("sh -c '") && command.includes('.worktrees/@deps')) return { lines: [`hopper-deps-${o.deps ?? 'none'}`] };
  // A job worktree command (job-worktree.ts): `cd 'work tree' && { printf … worktree running; o=$(sh -c '…' hopper-worktree 'a' 'b' 'repo' 'url' '1' …`,
  // that it runs (issue #518), then its outcome, two printf words each: made in the top of the job's repository, else
  // checkout when the job names a repository (issues #361, #431, #1103); none with job worktrees off.
  const worktree = /^cd '([^']*)' && \{ printf 'hopper-%s-%s\\n' worktree running; o=\$\(sh -c '.*' hopper-worktree '[^']*' '[^']*' '([^']*)' '[^']*' '([01])'/s.exec(command);
  if (worktree) {
    const [, tree, repo, on] = worktree;
    const top = (o.repositories ?? []).includes(tree!);
    const origin = o.origins?.[tree!];
    const own = !repo || !origin || origin.toLowerCase() === repo.toLowerCase();
    const found = top && own ? 'made' : repo ? 'checkout' : 'none';
    const outcome = on !== '1' || found === 'none' ? 'none' : o.worktreeFails ? 'unmade' : found;
    return { lines: ['hopper-worktree-running', ...(outcome === 'unmade' ? ['fatal: could not create work tree dir: Permission denied'] : []), `hopper-job-worktree-${outcome}`] };
  }
  // `[mkdir -p 'dir' && ]cd 'dir' && … && printf 'a%s\n' b || printf 'a%s\n' c`: c when the shell
  // cannot enter dir (and did not make it), else b.
  const entered = /^(mkdir -p '[^']*' && )?cd '([^']*)' && .*printf '([^']*)%s\\n' (\S+) \|\| printf '[^']*%s\\n' (\S+)$/.exec(command);
  if (entered) {
    const [, made, dir, prefix, ok, bad] = entered;
    const unusable = !made && (o.unusableDirs ?? []).includes(dir!);
    return { lines: unusable ? [`cd: no such file or directory: ${dir}`, `${prefix}${bad}`] : [`${prefix}${ok}`] };
  }
  // What a trailing `printf 'a%s\n' b` prints: the shell ran the command.
  const printed = /printf '([^']*)%s\\n' (\S+)$/.exec(command);
  return { lines: printed ? [`${printed[1]}${printed[2]}`] : [] };
}

/** Claude's config in the fake machine's home (FakeHerdrOptions.claudeConfig), `seeded` once the seed wrote it. */
export type FakeClaudeConfig = 'absent' | 'present' | 'unwritable' | 'seeded';

/**
 * The seed of Claude's config (claude-config.ts, issue #533), when `command` is it: its arguments (the work tree, trust,
 * yolo), the line it prints, and the config after it — written only where there was none.
 */
export function seedSays(command: string, config: FakeClaudeConfig): { args: string[]; line: string; config: FakeClaudeConfig } | undefined {
  const seed = /^sh -c '.*' hopper-claude-config '([^']*)' ([01]) ([01])$/s.exec(command);
  if (!seed) return undefined;
  const said = config === 'absent' ? 'seeded' : config === 'unwritable' ? 'unwritable' : 'kept';
  return { args: seed.slice(1), line: `hopper-claude-config-${said}`, config: said === 'seeded' ? 'seeded' : config };
}
