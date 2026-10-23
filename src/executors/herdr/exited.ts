// What Claude left when it exited in a job's pane (issue #2432, design.md "Exit at start"): its exit code, read from the
// pane's shell, and what it printed after its own command line, never the setup commands before it. Claude exiting as it
// started, or in the task's turn of a new session before it showed anything, is an exit at start: the seat's fault, not
// the job's (src/failures/causes.ts `exited-at-start`).
// The kernel's OOM kills in the job's scope (issue #2498) say the job ran into a resource limit, not its code: then the failure
// says so (src/failures/causes.ts `resource-limit`), and the job runs again.
import type { ExecutionContext } from '../../domain/ports.ts';
import { scopeUnitOf } from '../../client/reap.ts';
import { awaitOnScreen, type PaneWaitDeps } from './pane-wait.ts';

/** What the exit code command prints, followed by the code. */
export const EXIT_CODE_MARK = 'hopper-claude-exit-';
/** The shell's status of its last command, Claude's, as one line: typed at the prompt Claude left. */
export const EXIT_CODE_COMMAND = `printf '${EXIT_CODE_MARK}%s\\n' "$?"`;
/** What the OOM kills command prints, followed by the count, or `none` when the shell is not in the job's scope. */
export const OOM_KILLS_MARK = 'hopper-oom-kills-';
/** How many processes of the job's scope the OOM killer stopped (`memory.events` `oom_kill`), read from the shell's own cgroup: only the job's scope. */
export const oomKillsCommand = (jobId: string): string =>
  `g=$(sed -n 's/^0:://p' /proc/self/cgroup 2>/dev/null); case "$g" in */${scopeUnitOf(jobId)}.scope) k=$(sed -n 's/^oom_kill //p' "/sys/fs/cgroup$g/memory.events" 2>/dev/null);; *) k=none;; esac; printf '${OOM_KILLS_MARK}%s\\n' "\${k:-0}"`;
/** How long the shell has to print the exit code. */
const EXIT_CODE_WAIT_MS = 5000;
/** How many of the lines Claude printed the error keeps. */
const SAID_LINES = 20;

/** The exit code the screen shows, the last one; undefined when none. */
export function exitCodeOf(screen: string): number | undefined {
  const codes = screen.split('\n').map((l) => /^hopper-claude-exit-(\d+)$/.exec(l.trim())?.[1]).filter((c) => c !== undefined);
  return codes.length ? Number(codes.at(-1)) : undefined;
}

/** The OOM kill count the screen shows, the last one; undefined when none, or the shell is not in the job's scope. */
export function oomKillsOf(screen: string): number | undefined {
  const counts = screen.split('\n').map((l) => /^hopper-oom-kills-(\d+)$/.exec(l.trim())?.[1]).filter((c) => c !== undefined);
  return counts.length ? Number(counts.at(-1)) : undefined;
}

/**
 * What Claude printed: the lines after its command line (`--session-id`, the line herdr typed for a new session), its
 * shell prompt after them left out; else the screen's last lines. Its stderr is on the screen too: the pane is its terminal.
 */
export function claudeSaid(screen: string): string {
  const lines = screen.split('\n');
  const at = lines.findLastIndex((l) => /(^|\s)--session-id\s/.test(l));
  const after = at < 0 ? lines : lines.slice(at + 1);
  while (after.length && /^\s*(\S*[$#%>❯]\s*)?$/.test(after.at(-1)!)) after.pop();
  return after.slice(-SAID_LINES).join('\n').trim();
}

/** A shell status above 128: a signal ended the process. */
const codeText = (code: number | undefined): string =>
  code === undefined ? 'exit code unknown' : code > 128 && code < 160 ? `exit code ${code}, signal ${code - 128}` : `exit code ${code}`;

/**
 * The failure of a Claude that exited: `atStart` names when (`startup`, or the task's turn of a new session with nothing
 * shown). The screen is read first, then the exit code and the OOM kills in the job's scope asked of the pane's shell; a
 * pane that cannot be read or asked says so in the text.
 */
export async function exitedError(d: PaneWaitDeps, ctx: ExecutionContext, paneId: string, atStart?: 'startup' | 'new-session'): Promise<string> {
  const screen = await d.herdr.read(paneId, { source: 'recent-unwrapped', lines: 60 }).catch(() => undefined);
  let code: number | undefined;
  let kills: number | undefined;
  try {
    await d.herdr.runInPane(paneId, EXIT_CODE_COMMAND);
    code = (await awaitOnScreen(d, ctx, paneId, EXIT_CODE_MARK, exitCodeOf, EXIT_CODE_WAIT_MS)).found;
    await d.herdr.runInPane(paneId, oomKillsCommand(ctx.job.id));
    kills = (await awaitOnScreen(d, ctx, paneId, OOM_KILLS_MARK, oomKillsOf, EXIT_CODE_WAIT_MS)).found;
  } catch { /* the pane is gone: no code */ }
  const said = screen === undefined ? '(the pane could not be read)' : claudeSaid(screen) || '(it printed nothing)';
  const when = atStart === 'startup' ? ' at startup' : atStart === 'new-session' ? ' at the start of a new session, before any output' : '';
  const limit = kills ? ` at a resource limit: the kernel's OOM killer stopped ${kills} process${kills === 1 ? '' : 'es'} in the job's scope` : '';
  return `claude exited${when} (${codeText(code)})${limit}: ${said}`;
}
