// What the fake herdr's pane shell prints for each command the executor types into it (fake-client.ts):
// the scratch command, the job's scope (issue #410), the job worktree (issue #379), shared dependencies
// (issue #410), and any command ending in a split printf. Pure: the options and whether the shell already
// runs in the job's scope decide it.

/** What the shell does with a typed command: the lines it prints, and whether it now runs in the job's scope. */
export interface ShellSaid { lines: string[]; scoped?: true }

export interface FakeShellOptions {
  scopes?: boolean;
  deps?: string;
  repositories?: string[];
  worktreeFails?: boolean;
  unusableDirs?: string[];
}

export function shellSays(command: string, o: FakeShellOptions, scoped: boolean): ShellSaid {
  // The job's scope (job-scope.ts): with systemd the shell is replaced by one in the scope and prints
  // nothing; without, it says none. Asked where it runs, it says whether that is the scope.
  if (command.includes('exec systemd-run --user --scope')) return o.scopes ? { lines: [], scoped: true } : { lines: ['hopper-scope-none'] };
  if (command.startsWith('case "$(cat /proc/self/cgroup')) return { lines: [`hopper-scope-${scoped ? 'entered' : 'outside'}`] };
  // Sharing dependencies (shared-deps.ts): its outcome.
  if (command.startsWith("sh -c '") && command.includes('.hopper-scratch/deps')) return { lines: [`hopper-deps-${o.deps ?? 'none'}`] };
  // A job worktree command: `cd 'work tree' && if …`, its outcome two printf words.
  const worktree = /^cd '([^']*)' && if .*printf 'hopper-job-%s-%s\\n' worktree/.exec(command);
  if (worktree) {
    const outcome = !(o.repositories ?? []).includes(worktree[1]!) ? 'none' : o.worktreeFails ? 'unmade' : 'made';
    return { lines: [...(outcome === 'unmade' ? ['fatal: could not create work tree dir: Permission denied'] : []), `hopper-job-worktree-${outcome}`] };
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
