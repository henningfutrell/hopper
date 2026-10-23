// The job's isolation in its pane, before Claude starts (issue #1295): its own container runtime (src/client/job-runtime.ts),
// then the sandbox around Claude (src/client/job-sandbox.ts). Steps of start.ts's start.

import type { ExecutionContext, ExecutionOutcome } from '../../domain/ports.ts';
import { tail } from './monitor.ts';
import { GUARDS_MARK, RUNTIME_MARK, RUNTIME_SUBDIR, guardsCommand, guardsOutcome, runtimeOutcome, setupCommand } from '../../client/job-runtime.ts';
import { SANDBOX_MARK, sandboxCommand, sandboxOutcome } from '../../client/job-sandbox.ts';
import { jobScratchOf } from '../../domain/job-layout.ts';
import { awaitOnScreen } from './pane-wait.ts';
import type { PaneState, StartDeps, StartTimedOut } from './start.ts';

/** How long writing the job's guards may take (issue #2234): two files. */
const GUARDS_WAIT_MS = 30000;
/** How long setting up the job's own container runtime may take (issue #1295): it writes a few files and starts its socket. */
const RUNTIME_WAIT_MS = 60000;
/** How long setting up the job's sandbox may take (issue #1295): a trial run of bubblewrap, and two scripts written. */
const SANDBOX_WAIT_MS = 30000;

/**
 * Give the job its own container runtime (issue #1295, src/client/job-runtime.ts), in the pane's shell, after it entered
 * the job's scope, so the runtime's socket runs in the scope: its runtime dir, its storage in the scratch dir, its socket,
 * put in the shell's environment, with podman and docker on its PATH guarded. A machine with no podman (or no runtime dir
 * of the user's) gives the job none, the host's socket closed all the same. A setup that failed fails the job: it would
 * run next to the host's runtime. A runtime set up is saved in the job's state (`containerRuntime`), for its resource ledger
 * (issue #2504). Null when done, else the failure.
 */
export async function enterRuntime(d: StartDeps, ctx: ExecutionContext, s: PaneState): Promise<ExecutionOutcome | StartTimedOut | null> {
  const scratch = jobScratchOf(s.cwd, ctx.job.id);
  // Two steps, each one line a terminal keeps (issue #2234): the guards first, then the setup once the shell read them.
  await d.herdr.runInPane(s.paneId, guardsCommand(scratch));
  const guards = await awaitOnScreen(d, ctx, s.paneId, GUARDS_MARK, guardsOutcome, GUARDS_WAIT_MS);
  if (ctx.signal.aborted) return null;
  if (guards.found === 'failed') return { kind: 'failed', error: `the job's own container runtime could not be set up on ${ctx.machine.id}: ${tail(guards.screen, 10)}` };
  if (!guards.found) return { startTimedOut: `pane ${s.paneId} never wrote the job's container runtime guards within ${GUARDS_WAIT_MS} ms: ${tail(guards.screen, 10)}` };
  await d.herdr.runInPane(s.paneId, setupCommand(ctx.job.id, scratch, true));
  const { found, screen } = await awaitOnScreen(d, ctx, s.paneId, RUNTIME_MARK, runtimeOutcome, RUNTIME_WAIT_MS);
  if (ctx.signal.aborted) return null;
  if (found === 'own') {
    ctx.progress('container runtime: the job\'s own (podman), apart from the host\'s');
    s.containerRuntime = `${scratch}/${RUNTIME_SUBDIR}`;
    ctx.saveState({ ...s });
  }
  else if (found === 'none') ctx.progress('container runtime: none for the job here (no podman, or no runtime dir of the user\'s); the host\'s is closed to it');
  else if (found === 'failed') return { kind: 'failed', error: `the job's own container runtime could not be set up on ${ctx.machine.id}: ${tail(screen, 10)}` };
  else return { startTimedOut: `pane ${s.paneId} never set up the job's container runtime within ${RUNTIME_WAIT_MS} ms: ${tail(screen, 10)}` };
  return null;
}

/**
 * Put the job's sandbox around Claude (issue #1295, src/client/job-sandbox.ts), in the pane's shell, after its container
 * runtime: the sandbox's `claude` first on the shell's PATH, so herdr's start of claude runs the real one in bubblewrap,
 * where the user's runtime dir shows only the job's own and no process of the host shows. A machine where bubblewrap cannot
 * run starts Claude as before. Null when done, else the failure.
 */
export async function enterSandbox(d: StartDeps, ctx: ExecutionContext, s: PaneState): Promise<ExecutionOutcome | StartTimedOut | null> {
  await d.herdr.runInPane(s.paneId, sandboxCommand(jobScratchOf(s.cwd, ctx.job.id)));
  const { found, screen } = await awaitOnScreen(d, ctx, s.paneId, SANDBOX_MARK, sandboxOutcome, SANDBOX_WAIT_MS);
  if (ctx.signal.aborted) return null;
  if (found === 'on') ctx.progress('sandbox: Claude runs in a sandbox that shows only the job\'s own container runtime and processes');
  else if (found === 'none') ctx.progress('sandbox: none here (no bubblewrap that runs); Claude runs as the user does');
  else if (found === 'failed') return { kind: 'failed', error: `the job's sandbox could not be set up on ${ctx.machine.id}: ${tail(screen, 10)}` };
  else return { startTimedOut: `pane ${s.paneId} never set up the job's sandbox within ${SANDBOX_WAIT_MS} ms: ${tail(screen, 10)}` };
  return null;
}
