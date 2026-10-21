// A pane herdr restored after a server restart (issue #1465, docs/design.md "A pane herdr restored"): herdr gives the pane
// a new terminal and resumes Claude in it by itself, in a shell without the tab's environment (HOPPER_*, git's way to GitHub
// through the hopper), outside the job's scope and sandbox. The hopper sees the terminal change and starts Claude again in a
// new pane (executor.ts `restartRestored`). Apart from monitor.ts and executor.ts for their line budgets.
// A pane lost while its job waited (issue #1508: the machine or herdr restarted, and herdr did not restore it): the answer
// goes to Claude resumed in a new pane, set up as at the start, as for a restored pane (`resumeLostPane`).
import type { ExecutionContext, ExecutionOutcome } from '../../domain/ports.ts';
import type { AgentInfo } from './client.ts';
import { heldOf, lastLineOf, type HeldPane } from './panes.ts';
import type { ClaudeJobPayload } from './payload.ts';
import type { PaneState } from './start.ts';

/** The watch saw Claude outside the pane the hopper opened: the executor starts Claude again. `agentPane`: where it runs. */
export type PaneRestored = { paneRestored: true; agentPane: string };

/** Whether the agent's pane is in another terminal than `terminal`, the one the hopper opened. Either unknown: no. */
export const restoredByHerdr = (agent: Pick<AgentInfo, 'terminalId'>, terminal: string | undefined): boolean =>
  terminal !== undefined && agent.terminalId !== undefined && agent.terminalId !== terminal;

/**
 * Whether Claude runs outside the pane the hopper set up for the job: in another pane (issue #2320: herdr resumed it there
 * by itself), or in the same pane in another terminal (issue #1465). Either way its shell has none of the job's variables.
 */
export const outsideItsPane = (agent: Pick<AgentInfo, 'paneId' | 'terminalId'>, s: { paneId: string; terminal?: string | undefined }): boolean =>
  agent.paneId !== s.paneId || restoredByHerdr(agent, s.terminal);

/** What the job is told in its new pane: what failed since the restart failed for want of its environment. One line. */
export const RESTORED_NOTE = '[hopper] herdr restarted and resumed this session in a shell without the job\'s environment. The hopper stopped it and resumed the session in a new pane, set up as at the start: the HOPPER_* variables and git\'s way to GitHub through the hopper are back. A command that failed since the restart for want of them (git to GitHub, the hopper\'s scripts) can run again now. Go on with the job.';

/** What the restart needs of the executor: the close of a pane as at a park, and a new pane's start and first send. */
export interface RestartDeps {
  exitAndClose(pane: HeldPane): Promise<string | undefined>;
  startAndSend(ctx: ExecutionContext, p: ClaudeJobPayload, o: { resume: string }, text: () => [string, string]): Promise<ExecutionOutcome>;
}

/**
 * Claude in the restored pane `s` is stopped and the pane closed, its worktree and session kept, as at a park; so is the pane
 * `agentPane` Claude runs in when herdr resumed it in another one (issue #2320). Then a new pane opens as at the start (the
 * job's environment, scope and sandbox), Claude resumes the same session, and `text` goes to it. With no agent session
 * recorded, the job fails: a fresh one would lose what the job did.
 */
export async function restartInNewPane(d: RestartDeps, ctx: ExecutionContext, s: PaneState, p: ClaudeJobPayload, text: string, agentPane = s.paneId): Promise<ExecutionOutcome> {
  const session = s.agentSession ?? ctx.job.agentSession;
  ctx.progress(`herdr restored the job's pane after a restart, in a shell without the job's environment: ${session ? `Claude resumes agent session ${session} in a new pane` : 'no agent session is recorded to resume'}`);
  if (agentPane !== s.paneId) await d.exitAndClose(heldOf({ ...s, paneId: agentPane }, ctx.job.id));
  await d.exitAndClose(heldOf(s, ctx.job.id));
  if (!session) return { kind: 'failed', error: 'herdr restored the job\'s pane after a restart, without the job\'s environment, and no agent session is recorded to resume in a new pane' };
  return d.startAndSend(ctx, { ...p, cwd: s.cwd, makeWorkTree: false }, { resume: session }, () => [text, lastLineOf(text)]);
}

/** What a job is told first in the new pane it resumes in, its pane lost while it waited (issue #1508). One line. */
export const LOST_NOTE = '[hopper] The job\'s pane was lost while it waited (its machine or herdr restarted). The hopper resumed this session in a new pane, set up as at the start. A background command you started in the old pane stopped with it.';

/** What a job is told first in the new pane it resumes in, its agent ended on its wait to free memory (issue #2303). One line. */
export const RELEASED_NOTE = '[hopper] The hopper ended this session\'s agent while you waited, to free memory for other jobs on the machine. The hopper resumed this session in a new pane, set up as at the start, in the same work tree. A background command you started in the old pane stopped with it.';

/** What the resume of a lost pane needs of the executor: the close of a pane as at a park, and a new pane's start and first send. */
export interface LostDeps {
  exitAndClose(pane: HeldPane): Promise<string | undefined>;
  startAndSend(ctx: ExecutionContext, p: ClaudeJobPayload, o: { resume: string; first: () => Promise<unknown> }, text: () => [string, string]): Promise<ExecutionOutcome>;
}

/**
 * The pane `s` of a job that waited is gone (issue #1508): what is left of the job on its machine is stopped and the pane
 * closed — herdr resumes no Claude there later, in a shell without the job's variables (issue #2320) —, then a new pane
 * opens as at the start, Claude resumes the same session, and `text` goes to it. With no agent session recorded, the job
 * fails, `pane lost`: a fresh one would lose what the job did.
 */
export function resumeLostPane(d: LostDeps, ctx: ExecutionContext, s: PaneState, p: ClaudeJobPayload, text: string): Promise<ExecutionOutcome> {
  const session = s.agentSession ?? ctx.job.agentSession;
  if (!session) return Promise.resolve({ kind: 'failed', error: 'pane lost' });
  ctx.progress(`the job's pane was lost while it waited: Claude resumes agent session ${session} in a new pane`);
  return d.startAndSend(ctx, { ...p, cwd: s.cwd, makeWorkTree: false }, { resume: session, first: () => d.exitAndClose(heldOf(s, ctx.job.id)) }, () => [text, lastLineOf(text)]);
}
