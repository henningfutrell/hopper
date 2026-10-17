// A pane herdr restored after a server restart (issue #1465, docs/design.md "A pane herdr restored"): herdr gives the pane
// a new terminal and resumes Claude in it by itself, in a shell without the tab's environment (HOPPER_*, git's way to GitHub
// through the hopper), outside the job's scope and sandbox. The hopper sees the terminal change and starts Claude again in a
// new pane (executor.ts `restartRestored`). Apart from monitor.ts and executor.ts for their line budgets.
import type { ExecutionContext, ExecutionOutcome } from '../../domain/ports.ts';
import type { AgentInfo } from './client.ts';
import { heldOf, lastLineOf, type HeldPane } from './panes.ts';
import type { ClaudeJobPayload } from './payload.ts';
import type { PaneState } from './start.ts';

/** The watch saw the pane in another terminal than the one the hopper opened: the executor starts Claude again. */
export type PaneRestored = { paneRestored: true };

/** Whether the agent's pane is in another terminal than `terminal`, the one the hopper opened. Either unknown: no. */
export const restoredByHerdr = (agent: Pick<AgentInfo, 'terminalId'>, terminal: string | undefined): boolean =>
  terminal !== undefined && agent.terminalId !== undefined && agent.terminalId !== terminal;

/** What the job is told in its new pane: what failed since the restart failed for want of its environment. One line. */
export const RESTORED_NOTE = '[hopper] herdr restarted and resumed this session in a shell without the job\'s environment. The hopper stopped it and resumed the session in a new pane, set up as at the start: the HOPPER_* variables and git\'s way to GitHub through the hopper are back. A command that failed since the restart for want of them (git to GitHub, the hopper\'s scripts) can run again now. Go on with the job.';

/** What the restart needs of the executor: the close of a pane as at a park, and a new pane's start and first send. */
export interface RestartDeps {
  exitAndClose(pane: HeldPane): Promise<string | undefined>;
  startAndSend(ctx: ExecutionContext, p: ClaudeJobPayload, o: { resume: string }, text: () => [string, string]): Promise<ExecutionOutcome>;
}

/**
 * Claude in the restored pane `s` is stopped and the pane closed, its worktree and session kept, as at a park; then a new
 * pane opens as at the start (the job's environment, scope and sandbox), Claude resumes the same session, and `text` goes
 * to it. With no agent session recorded, the job fails: a fresh one would lose what the job did.
 */
export async function restartInNewPane(d: RestartDeps, ctx: ExecutionContext, s: PaneState, p: ClaudeJobPayload, text: string): Promise<ExecutionOutcome> {
  const session = s.agentSession ?? ctx.job.agentSession;
  ctx.progress(`herdr restored the job's pane after a restart, in a shell without the job's environment: ${session ? `Claude resumes agent session ${session} in a new pane` : 'no agent session is recorded to resume'}`);
  await d.exitAndClose(heldOf(s, ctx.job.id));
  if (!session) return { kind: 'failed', error: 'herdr restored the job\'s pane after a restart, without the job\'s environment, and no agent session is recorded to resume in a new pane' };
  return d.startAndSend(ctx, { ...p, cwd: s.cwd, makeWorkTree: false }, { resume: session }, () => [text, lastLineOf(text)]);
}
