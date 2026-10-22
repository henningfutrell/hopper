// What a herdr-claude start needs before its pane opens (docs/design.md "Phase 2" → "herdr-claude executor"): the
// claimed machine checked, the payload resolved on it, the task's text; and for a parked job picked up to resume
// elsewhere (issue #921, "Checkpoints and resume elsewhere"), its checkpoint's restore command. Pure; no I/O.
import type { ExecutionContext, ExecutionOutcome } from '../../domain/ports.ts';
import type { CheckpointCapture, Job } from '../../domain/types.ts';
import { restoreCommand } from '../../client/checkpoint.ts';
import type { HerdrClient } from './client.ts';
import { paneStateOf, type Where } from './panes.ts';
import { resolvePayload, workTreeOn, type ClaudeJobPayload } from './payload.ts';
import { protocolFooter } from './screen.ts';
import { jobScratchOf, type PaneState } from './start.ts';

/** Why herdr-claude does not run on the claimed machine, or undefined. */
export function notHere(m: ExecutionContext['machine']): ExecutionOutcome | undefined {
  // A container target (issue #58) has no herdr; without this the job would run on this machine.
  if (m.containerImage) return { kind: 'failed', error: `herdr-claude does not run on container target ${m.id}: it has no herdr; give it the command executor` };
  // An ssh target that runs no herdr (issue #142): without this the job would run in this machine's herdr.
  if (m.ssh && !m.herdr) return { kind: 'failed', error: `herdr-claude does not run on ${m.id}: it runs no herdr; give it another executor` };
  return undefined;
}

/** A new start's payload on the claimed machine, its work tree resolved there; else the outcome that refuses it. */
export function payloadOn(ctx: ExecutionContext): ClaudeJobPayload | ExecutionOutcome {
  const refused = notHere(ctx.machine);
  if (refused) return refused;
  const asked = resolvePayload(ctx.job, ctx.machine);
  // Issue #323: `~` is the lane's machine's home, never this process's when the job runs elsewhere.
  const tree = workTreeOn(ctx.machine, asked.cwd);
  return 'error' in tree ? { kind: 'failed', error: tree.error } : { ...asked, cwd: tree.cwd };
}

/** The task as a new session gets it: the prompt, `brief` if any, then the protocol footer for the pane `s`. */
export const taskText = (ctx: ExecutionContext, p: ClaudeJobPayload, s: PaneState, brief?: string): string =>
  `${p.prompt}\n\n${brief ? `${brief}\n\n` : ''}${protocolFooter(p.cwd, ctx.jobRules, jobScratchOf(p.cwd, ctx.job.id), s.jobWorktree, s.sharedDependencies === true, s.checkout)}`;

/** A start that resumes a job elsewhere: its payload on the new machine, its session, the restore command, what it says. */
export interface Relocation { p: ClaudeJobPayload; session: string; restore: string; said: string }

/** How a parked job resumes elsewhere from its checkpoint (issue #921); else the outcome that refuses it. */
export function relocation(ctx: ExecutionContext): Relocation | ExecutionOutcome {
  const k = ctx.job.checkpoint;
  const session = ctx.job.agentSession;
  if (!k?.session || !session) return { kind: 'failed', error: 'the job has no checkpoint with its agent session to resume elsewhere from' };
  const p = payloadOn(ctx);
  if ('kind' in p) return p;
  return {
    p, session, restore: restoreCommand({ base: k.base, ...(k.pushedTo ? { branch: k.pushedTo, pushed: k.head } : k.branch ? { branch: k.branch } : {}), session, hasSession: true }),
    said: `resumed agent session ${session} on ${ctx.machine.id} from the checkpoint taken on ${k.machineId} at ${k.at}`,
  };
}

/** A job's checkpoint (issue #921), read on its machine through its own connection; undefined with nothing to read. */
export async function checkpointOn(job: Job, herdrOn: (w: Where) => HerdrClient): Promise<CheckpointCapture | undefined> {
  const state = paneStateOf(job);
  if (!state?.jobWorktree || !job.agentSession) return undefined;
  return herdrOn(state).checkpoint?.(job.id, state.jobWorktree, job.agentSession);
}
