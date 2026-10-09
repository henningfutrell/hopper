// Claude's startup in a job's pane (issue #533, design.md "Startup screens"): its config seeded where the machine has
// none, then the wait until its input box shows, each screen before it answered with its default (startup-screens.ts).
// A screen the hopper may not answer leaves Claude up at it: the send asks it of a person (issue #534, before-send.ts).
import type { ExecutionContext, ExecutionOutcome } from '../../domain/ports.ts';
import { CLAUDE_CONFIG_MARK, claudeConfigOutcome, seedClaudeConfigCommand } from './claude-config.ts';
import { tail } from './monitor.ts';
import { awaitOnScreen } from './pane-wait.ts';
import type { PaneState, StartDeps, StartTimedOut } from './start.ts';
import { asksSomething, notSignedIn, promptShown, startupStep, type StartupPolicy } from './startup-screens.ts';

/** How long Claude has to come up once started, its startup screens answered (issue #527: a Windows machine's PowerShell launch is slow). */
const SETTLE_TIMEOUT_MS = 120000;
/** Startup screens answered at most: folder trust, external imports, the bypass permissions warning, the theme, the API key and notices, with room to spare. */
export const MAX_STARTUP_SCREENS = 8;
/** How long a screen that asks nothing, herdr calling Claude up, stays as it is before Claude is taken as up without its input box seen. */
const READY_GRACE_MS = 5000;
/**
 * How long Claude's input box stays on screen before Claude is taken as ready: it draws the box before it says it is
 * not signed in (seen live, issue #533).
 */
const PROMPT_STEADY_MS = 2000;
/** How long seeding Claude's config may take. */
const SEED_WAIT_MS = 10000;

/** What decides the answer to a startup screen: the instance's options, and the directory Claude starts in. */
export const policyOf = (d: Pick<StartDeps, 'trustWorkdir' | 'yolo' | 'unattended'>, s: PaneState): StartupPolicy => ({
  cwd: s.jobWorktree ?? s.cwd, trustWorkdir: d.trustWorkdir, yolo: d.yolo, unattended: d.unattended,
});

/**
 * Wait until Claude is up: its input box on screen (`promptShown`) for PROMPT_STEADY_MS — herdr calls Claude idle and
 * ready at its first-run theme picker (issue #533), so herdr's word alone is never enough. Each screen before it is
 * decided on by its text (`startupStep`), never by herdr's `state_change_seq`, which does not move between Claude's
 * startup dialogs; the screen just answered is not answered again. A screen the hopper may not answer, or Claude not
 * signed in, leaves it up all the same: the send finds it and asks it of a person (issue #534). A screen that asks
 * nothing (issue #527: a launch line echoed, Claude still drawing) is looked at again; with herdr calling Claude up and
 * the screen unchanged for READY_GRACE_MS, Claude is taken as up. Counted in polls, not by the clock: a wait only time
 * ends would never end on a clock that stands still. `started`: herdr's agent start found Claude ready. Null when up
 * (or aborted), else the failure or the start that timed out, to be tried again in a new pane.
 */
export async function settleStartup(d: StartDeps, ctx: ExecutionContext, s: PaneState, started: boolean): Promise<ExecutionOutcome | StartTimedOut | null> {
  const until = d.clock.now().getTime() + SETTLE_TIMEOUT_MS;
  const policy = policyOf(d, s);
  const polls = (ms: number): number => Math.max(1, Math.ceil(ms / d.pollMs));
  let answered: string | undefined;
  let count = 0;
  let quiet: { screen: string; polls: number } | undefined;
  let promptPolls = 0;
  while (d.clock.now().getTime() < until) {
    if (ctx.signal.aborted) return null;
    const agent = await d.herdr.getAgent(s.agentName);
    if (!agent) return { kind: 'failed', error: 'claude exited at startup' };
    const screen = await d.herdr.read(s.paneId, { source: 'visible', lines: 60 });
    if (promptShown(screen)) {
      if (notSignedIn(screen) || ++promptPolls > polls(PROMPT_STEADY_MS)) return null;
    } else {
      promptPolls = 0;
      const step = screen === answered ? undefined : startupStep(screen, policy);
      if (step && ('ask' in step || count >= MAX_STARTUP_SCREENS)) return null;
      if (step) {
        await d.herdr.sendKeys(s.paneId, step.keys);
        ctx.progress(0, step.did);
        answered = screen;
        count++;
        quiet = undefined;
      } else if ((agent.status === 'idle' || agent.status === 'done' || (started && agent.status !== 'blocked')) && screen !== answered && !asksSomething(screen)) {
        if (quiet?.screen !== screen) quiet = { screen, polls: 0 };
        else if (++quiet.polls >= polls(READY_GRACE_MS)) return null;
      } else quiet = undefined;
    }
    await d.sleep(d.pollMs, ctx.signal);
  }
  const screen = await d.herdr.read(s.paneId, { source: 'visible', lines: 60 });
  return { startTimedOut: `claude not ready at startup: ${tail(screen, 30)}` };
}

/**
 * Seed Claude's config in the pane's own shell where the machine has none (issue #533, claude-config.ts), so a fresh
 * home shows no first-run screen. Whatever it says, Claude starts: a config it kept or could not write leaves its
 * screens to `settleStartup`.
 */
export async function seedClaudeConfig(d: StartDeps, ctx: ExecutionContext, s: PaneState): Promise<void> {
  await d.herdr.runInPane(s.paneId, seedClaudeConfigCommand(s.cwd, d.trustWorkdir, d.yolo));
  const { found } = await awaitOnScreen(d, ctx, s.paneId, CLAUDE_CONFIG_MARK, claudeConfigOutcome, SEED_WAIT_MS);
  if (found === 'seeded') ctx.progress(0, "seeded claude's config: the machine had none");
  if (found === 'unwritable') ctx.progress(0, "claude's config could not be seeded: its startup screens get their defaults");
}
