// Opening a job's pane and getting Claude ready in it: workspace, tab, agent start, and the
// folder-trust dialog. docs/design.md "Phase 2" → "Start".

import type { Clock, ExecutionContext, ExecutionOutcome } from '../../domain/ports.ts';
import type { HerdrClient } from './client.ts';
import type { Sleep } from './monitor.ts';
import { tail } from './monitor.ts';
import type { ClaudeJobPayload } from './payload.ts';
import { isTrustDialog } from './screen.ts';

export const WORKSPACE_LABEL = 'job-hopper';
const START_TIMEOUT_MS = 60000;

/** What a job keeps in `job.executorState`. */
export interface PaneState {
  session?: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  agentName: string;
  cwd: string;
  laneId: string;
  /** The turn in flight, recorded at every send, so a restarted daemon can watch it again. */
  turn?: TurnAnchor;
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
}

export const agentNameFor = (jobId: string): string => `jh-${jobId.slice(0, 8)}`;

/** Create the tab and record it at once, before anything can fail in it. */
export async function openPane(d: StartDeps, ctx: ExecutionContext, cwd: string, env: Record<string, string>): Promise<PaneState> {
  const workspaceId = await d.herdr.ensureWorkspace(WORKSPACE_LABEL, cwd);
  const { tabId, paneId } = await d.herdr.createTab({
    workspaceId, cwd, label: `${ctx.laneId} · ${ctx.job.id.slice(0, 8)}`,
    // HOPPER_JOB_ID comes from the job itself; a payload cannot forge it.
    env: { ...env, HOPPER_JOB_ID: ctx.job.id },
  });
  const state: PaneState = {
    ...(d.herdr.session ? { session: d.herdr.session } : {}),
    workspaceId, tabId, paneId, agentName: agentNameFor(ctx.job.id), cwd, laneId: ctx.laneId,
  };
  ctx.saveState({ ...state });
  return state;
}

async function waitReady(d: StartDeps, ctx: ExecutionContext, s: PaneState): Promise<ExecutionOutcome | null> {
  const until = d.clock.now().getTime() + START_TIMEOUT_MS;
  while (d.clock.now().getTime() < until) {
    if (ctx.signal.aborted) return null;
    const agent = await d.herdr.getAgent(s.agentName);
    if (!agent) return { kind: 'failed', error: 'claude exited at startup' };
    if (agent.status === 'idle' || agent.status === 'done') return null;
    await d.sleep(d.pollMs, ctx.signal);
  }
  const screen = await d.herdr.read(s.paneId, { source: 'visible', lines: 60 });
  return { kind: 'failed', error: `claude not ready after trusting the workdir: ${tail(screen, 30)}` };
}

/**
 * Start Claude in the pane. Resolves null when Claude is ready for the prompt (or the signal
 * fired — the caller checks), else the failure to report; the caller closes the pane.
 */
export async function startClaude(d: StartDeps, ctx: ExecutionContext, s: PaneState, p: ClaudeJobPayload): Promise<ExecutionOutcome | null> {
  const args = [...d.claudeArgs, ...(p.model ? ['--model', p.model] : [])];
  const started = await d.herdr.startAgent({ name: s.agentName, paneId: s.paneId, args, timeoutMs: START_TIMEOUT_MS });
  if (started.ok) return null;
  const screen = await d.herdr.read(s.paneId, { source: 'visible', lines: 60 });
  if (!(d.trustWorkdir && isTrustDialog(screen, s.cwd))) {
    return { kind: 'failed', error: `claude blocked at startup: ${tail(screen, 30)}` };
  }
  await d.herdr.sendKeys(s.paneId, ['down', 'enter']);
  ctx.progress(0, `trusted workdir ${s.cwd}`);
  return waitReady(d, ctx, s);
}
