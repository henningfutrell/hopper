// Opening a job's pane and getting Claude ready in it: workspace, tab, agent start, and the
// startup dialogs (folder trust; the bypass permissions warning when yolo). docs/design.md "Phase 2" → "Start".

import type { Clock, ExecutionContext, ExecutionOutcome } from '../../domain/ports.ts';
import type { HerdrClient } from './client.ts';
import type { Sleep } from './monitor.ts';
import { tail } from './monitor.ts';
import type { ClaudeJobPayload } from './payload.ts';
import { SCRATCH_DIR, isBypassDialog, isTrustDialog } from './screen.ts';
import { shellQuote } from '../ssh.ts';

export const WORKSPACE_LABEL = 'hopper';
const START_TIMEOUT_MS = 60000;
const SHELL_RETRY_MS = 100;
/** What the scratch command prints last, so the hopper knows the shell ran it. */
const SCRATCH_READY = 'hopper-scratch-ready';
const SCRATCH_WAIT_MS = 1000;
/** Startup dialogs answered at most: folder trust and the bypass permissions warning, with room to spare. */
const MAX_STARTUP_DIALOGS = 4;

/** What grants Claude every permission: the flag, and the permission mode that means the same. */
const YOLO_FLAG = '--dangerously-skip-permissions';
const GRANTS_ALL = new Set([YOLO_FLAG, '--allow-dangerously-skip-permissions', '--permission-mode=bypassPermissions']);
/** Claude's own setting that the bypass permissions warning was accepted, given on the command line. */
export const YOLO_SETTINGS = JSON.stringify({ skipDangerousModePermissionPrompt: true });

/**
 * The arguments Claude starts with (issue #267, design.md "Yolo"): the instance's `yolo` decides
 * whether Claude has every permission, never its `args`. Yolo puts the flag first, with the setting that
 * its warning was accepted unless the args name settings of their own; not yolo drops every argument
 * that would grant it, so Claude asks and the hopper takes each dialog to the job's answerers.
 */
export function claudeArgsFor(yolo: boolean, args: readonly string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (GRANTS_ALL.has(args[i]!)) continue;
    if (args[i] === '--permission-mode' && args[i + 1] === 'bypassPermissions') { i++; continue; }
    rest.push(args[i]!);
  }
  if (!yolo) return rest;
  const named = rest.some((a) => a === '--settings' || a.startsWith('--settings='));
  return [YOLO_FLAG, ...(named ? [] : ['--settings', YOLO_SETTINGS]), ...rest];
}

/** What a job keeps in `job.executorState`. */
export interface PaneState {
  session?: string;
  /** The attached machine's ssh destination; absent → this machine's herdr. */
  ssh?: string;
  /** The attached machine's herdr binary (with `ssh`), so cleanup reaches the same herdr. */
  herdrBin?: string;
  /** A client target's: which machine, and the variable its token is in (design.md "Client targets"). */
  client?: { machine: string; tokenEnv: string };
  workspaceId: string;
  tabId: string;
  paneId: string;
  agentName: string;
  cwd: string;
  laneId: string;
  /** The turn in flight, recorded at every send, so a restarted daemon can watch it again. */
  turn?: TurnAnchor;
  /** state_change_seq when the turn parked on a question: Claude moving past it means the owner answered in the pane. */
  parkedSeq?: number;
}

/** What the monitor needs to find one turn's outcome: design.md "Turn anchor (B1)". */
export interface TurnAnchor {
  /** state_change_seq read just before the send. */
  seq: number;
  /** Last line of what was sent, as Claude echoes it. */
  anchor: string;
  /** Claude was at a dialog when we sent. */
  blockedAtSend: boolean;
}

export interface StartDeps {
  herdr: HerdrClient;
  clock: Clock;
  sleep: Sleep;
  pollMs: number;
  claudeArgs: string[];
  trustWorkdir: boolean;
  /** Claude starts with every permission granted: its warning about that is accepted at startup. */
  yolo: boolean;
}

export const agentNameFor = (jobId: string): string => `jh-${jobId.slice(0, 8)}`;

/** The job's scratch dir: Claude's scratchpad and every temp file, inside its work tree (design.md "Work tree"). */
export const scratchDirOf = (cwd: string): string => `${cwd.replace(/\/+$/, '')}/${SCRATCH_DIR}`;

/**
 * Create the tab and record it at once, before anything can fail in it. The tab's environment
 * points Claude's scratchpad and every temp file at the scratch dir.
 */
export async function openPane(d: StartDeps, ctx: ExecutionContext, cwd: string, env: Record<string, string>): Promise<PaneState> {
  const scratch = scratchDirOf(cwd);
  const workspaceId = await d.herdr.ensureWorkspace(WORKSPACE_LABEL, cwd);
  const { tabId, paneId } = await d.herdr.createTab({
    workspaceId, cwd, label: `${ctx.laneId} · ${ctx.job.id.slice(0, 8)}`,
    // HOPPER_JOB_ID and the scratch dir come from the hopper; a payload cannot move them.
    env: { ...env, CLAUDE_CODE_TMPDIR: scratch, TMPDIR: scratch, HOPPER_JOB_ID: ctx.job.id },
  });
  const state: PaneState = {
    ...(d.herdr.session ? { session: d.herdr.session } : {}),
    ...(ctx.machine.ssh && ctx.machine.herdr ? { ssh: ctx.machine.ssh, herdrBin: ctx.machine.herdr.bin } : {}),
    ...(ctx.machine.client ? { client: { machine: ctx.machine.id, tokenEnv: ctx.machine.client.tokenEnv } } : {}),
    workspaceId, tabId, paneId, agentName: agentNameFor(ctx.job.id), cwd, laneId: ctx.laneId,
  };
  ctx.saveState({ ...state });
  return state;
}

/**
 * Wait until Claude is ready for the prompt, answering the startup dialogs the hopper may answer: the
 * folder-trust dialog naming the job's cwd (when `trustWorkdir`), and the bypass permissions warning
 * (when yolo). Any other dialog fails the job with the screen. A dialog is judged once per state
 * change, so keys sent to one never land on the next. `started`: herdr's agent start found Claude
 * ready, so anything but a dialog is; else herdr found it held at one. Null when ready (or aborted),
 * else the failure.
 */
async function settleStartup(d: StartDeps, ctx: ExecutionContext, s: PaneState, started: boolean): Promise<ExecutionOutcome | null> {
  const until = d.clock.now().getTime() + START_TIMEOUT_MS;
  let answeredAt = -1;
  let answered = 0;
  while (d.clock.now().getTime() < until) {
    if (ctx.signal.aborted) return null;
    const agent = await d.herdr.getAgent(s.agentName);
    if (!agent) return { kind: 'failed', error: 'claude exited at startup' };
    if (agent.status === 'idle' || agent.status === 'done' || (started && answered === 0 && agent.status !== 'blocked')) return null;
    if ((agent.status === 'blocked' || (!started && answered === 0)) && agent.stateChangeSeq !== answeredAt) {
      const screen = await d.herdr.read(s.paneId, { source: 'visible', lines: 60 });
      const dialog = d.trustWorkdir && isTrustDialog(screen, s.cwd) ? `trusted workdir ${s.cwd}`
        : d.yolo && isBypassDialog(screen) ? 'accepted bypass permissions mode' : undefined;
      if (!dialog || answered >= MAX_STARTUP_DIALOGS) return { kind: 'failed', error: `claude blocked at startup: ${tail(screen, 30)}` };
      // Both dialogs open on their refusing option; the next one down accepts.
      await d.herdr.sendKeys(s.paneId, ['down', 'enter']);
      ctx.progress(0, dialog);
      answeredAt = agent.stateChangeSeq;
      answered++;
      continue;
    }
    await d.sleep(d.pollMs, ctx.signal);
  }
  const screen = await d.herdr.read(s.paneId, { source: 'visible', lines: 60 });
  return { kind: 'failed', error: `claude not ready at startup: ${tail(screen, 30)}` };
}

/**
 * Make the scratch dir in the pane's own shell, so on whichever machine the work tree is; its
 * `.gitignore` hides it from git. A fresh shell drops what is typed before its prompt, so the
 * command runs again until its output shows. Null when made, else the failure.
 */
async function makeScratch(d: StartDeps, ctx: ExecutionContext, s: PaneState): Promise<ExecutionOutcome | null> {
  const scratch = scratchDirOf(s.cwd);
  const command = `mkdir -p ${shellQuote(scratch)} && printf '*\\n' > ${shellQuote(`${scratch}/.gitignore`)} && printf 'hopper-scratch-%s\\n' ready`;
  for (let waited = 0; waited < START_TIMEOUT_MS; waited += SCRATCH_WAIT_MS) {
    if (ctx.signal.aborted) return null;
    await d.herdr.runInPane(s.paneId, command);
    if (await d.herdr.waitOutput(s.paneId, SCRATCH_READY, SCRATCH_WAIT_MS)) return null;
  }
  return { kind: 'failed', error: `pane ${s.paneId} never ran the scratch dir command within ${START_TIMEOUT_MS} ms` };
}

/**
 * Start Claude in the pane. Resolves null when Claude is ready for the prompt (or the signal
 * fired — the caller checks), else the failure to report; the caller closes the pane.
 */
export async function startClaude(d: StartDeps, ctx: ExecutionContext, s: PaneState, p: ClaudeJobPayload): Promise<ExecutionOutcome | null> {
  const unmade = await makeScratch(d, ctx, s);
  if (unmade || ctx.signal.aborted) return unmade;
  const args = [...d.claudeArgs, ...(p.model ? ['--model', p.model] : [])];
  const until = d.clock.now().getTime() + START_TIMEOUT_MS;
  let started = await d.herdr.startAgent({ name: s.agentName, paneId: s.paneId, args, timeoutMs: START_TIMEOUT_MS });
  // A pane spawned a moment ago is not at its shell prompt yet; herdr refuses `agent start` until it is.
  while (!started.ok && 'paneBusy' in started) {
    if (ctx.signal.aborted) return null;
    if (d.clock.now().getTime() >= until) return { kind: 'failed', error: `pane ${s.paneId} never reached its shell prompt within ${START_TIMEOUT_MS} ms` };
    await d.sleep(SHELL_RETRY_MS, ctx.signal);
    started = await d.herdr.startAgent({ name: s.agentName, paneId: s.paneId, args, timeoutMs: START_TIMEOUT_MS });
  }
  // Started, or held at a dialog (herdr's agent_not_ready): either way, a dialog may stand before the prompt.
  return settleStartup(d, ctx, s, started.ok);
}
