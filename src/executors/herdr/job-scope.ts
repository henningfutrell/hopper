// Each job's pane shell in a scope of its own (issue #410, design.md "Work tree" → "The job's scope"): the
// reap found jobs' processes by HOPPER_JOB_ID in their environment, and whatever clears its environment
// and leaves its session escaped it (46 such processes were found on one machine). Where the machine runs
// a systemd user manager, the pane's shell replaces itself with one in the transient user scope
// `hopper-job-<job id>`, so every process the job starts is in that scope's cgroup, whatever it does to
// its environment; the reap stops the scope (KillMode=control-group). Without systemd, the shell stays as
// it is and the reap falls back to the environment variable.
import { scopeUnitOf } from '../../client/server.ts';

/** What the scope commands print, followed by the outcome. */
export const SCOPE_MARK = 'hopper-scope-';

/** entered: the shell runs in the job's scope; none: the machine has no systemd user manager; outside: the shell is not in it. */
export type ScopeOutcome = 'entered' | 'none' | 'outside';

// Printed as two words, so the command's own echo never reads as its outcome.
const say = (outcome: ScopeOutcome): string => `printf 'hopper-%s-%s\\n' scope ${outcome}`;

/**
 * Replace the pane's shell with a login shell in the job's scope, keeping its directory and environment.
 * A trial run first, so a systemd that cannot make a scope leaves the shell as it is (an `exec` that fails
 * would end the pane). Prints nothing when it replaced the shell; `none` otherwise.
 */
export function enterScopeCommand(jobId: string): string {
  return 'if command -v systemd-run >/dev/null 2>&1 && systemd-run --user --scope --quiet --collect -- true >/dev/null 2>&1;'
    + ` then exec systemd-run --user --scope --quiet --collect --unit=${scopeUnitOf(jobId)} -p KillMode=control-group -p TimeoutStopSec=10s -- "\${SHELL:-/bin/sh}" -l; fi; ${say('none')}`;
}

/** Whether the shell runs in the job's scope: read from its own cgroup. */
export function scopeCheckCommand(jobId: string): string {
  return `case "$(cat /proc/self/cgroup 2>/dev/null)" in *'/${scopeUnitOf(jobId)}.scope'*) ${say('entered')};; *) ${say('outside')};; esac`;
}

/** The last scope outcome on the screen, if any. */
export function scopeOutcome(screen: string): ScopeOutcome | undefined {
  const last = screen.split('\n').map((l) => l.trim()).filter((l) => l.startsWith(SCOPE_MARK)).at(-1)?.slice(SCOPE_MARK.length);
  return last === 'entered' || last === 'none' || last === 'outside' ? last : undefined;
}
