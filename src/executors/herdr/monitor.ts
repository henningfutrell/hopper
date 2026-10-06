// Watches one Claude turn in its pane until an outcome: the polling half of the executor.
// docs/design.md "Phase 2" → "Monitor" and "Turn anchor (B1)".

import type { Clock, ExecutionContext, ExecutionOutcome } from '../../domain/ports.ts';
import type { HerdrClient } from './client.ts';
import { CTRL_END, isScrolledUp, readTurn } from './screen.ts';

export const RECENT_LINES = 200;
const OUTPUT_LINES = 120;
const SUMMARY_CHARS = 4000;
const MAX_CONSECUTIVE_ERRORS = 3;

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Why the turn stopped without an outcome; the executor decides what to do with the pane. */
export type Interrupt = { interrupt: 'cancel' | 'shutdown' | 'timeout' };

/** The turn ended without a marker (issue #163): progress, never a question. The executor nudges. */
export type StatusNote = { statusNote: string };

/**
 * A lost send (issue #278): Claude has sat ready since the send, its state never moved, and the turn
 * anchor is nowhere on screen. What was sent never reached Claude; the executor sends it again.
 */
export type LostSend = { lostSend: true };

export interface TurnWatch {
  herdr: HerdrClient;
  clock: Clock;
  sleep: Sleep;
  pollMs: number;
  /**
   * How long the turn sits idle without a marker before it counts as a status note; also how long Claude
   * may sit waiting with its state unmoved since the send before the turn counts as over all the same.
   */
  idleNudgeMs: number;
  ctx: ExecutionContext;
  agentName: string;
  paneId: string;
  /** Last line of what was sent, as Claude echoes it. */
  anchor: string;
  /** state_change_seq read just before the send. */
  seqAtSend: number;
  /** Claude was at a dialog when we sent (a stale `blocked` must not count). */
  blockedAtSend: boolean;
  timeoutMs: number;
  expectedMs: number;
  /** When the job's turn began, for `timeoutMs` and progress: a nudge goes on the same turn. Default now. */
  startedAt?: number;
  /** Called with state_change_seq when the turn parks on a question, before the outcome returns. */
  parked?: (seq: number) => void;
}

export function abortReason(signal: AbortSignal): 'cancel' | 'shutdown' {
  return signal.reason === 'shutdown' ? 'shutdown' : 'cancel';
}

export const tail = (text: string, lines: number): string => text.split('\n').slice(-lines).join('\n').trim();

async function exitedError(w: TurnWatch): Promise<string> {
  try {
    const last = await w.herdr.read(w.paneId, { source: 'recent-unwrapped', lines: 40 });
    return `claude exited: ${tail(last, 20)}`;
  } catch {
    return 'claude exited';
  }
}

async function blockedQuestion(w: TurnWatch, recent: string): Promise<ExecutionOutcome> {
  const visible = await w.herdr.read(w.paneId, { source: 'visible', lines: 60 });
  return { kind: 'question', question: { text: tail(visible, 30), recentOutput: tail(recent, OUTPUT_LINES), detectedBy: 'blocked' } };
}

export async function watchTurn(w: TurnWatch): Promise<ExecutionOutcome | Interrupt | StatusNote | LostSend> {
  const { herdr, clock, ctx } = w;
  const started = w.startedAt ?? clock.now().getTime();
  let lastLine = '';
  let idleSince: number | null = null;
  let waitingSince: number | null = null;
  let errors = 0;
  for (;;) {
    if (ctx.signal.aborted) return { interrupt: abortReason(ctx.signal) };
    const now = clock.now().getTime();
    if (now - started >= w.timeoutMs) return { interrupt: 'timeout' };
    try {
      const agent = await herdr.getAgent(w.agentName);
      if (ctx.signal.aborted) continue;
      if (!agent) return { kind: 'failed', error: await exitedError(w) };
      let recent = await herdr.read(w.paneId, { source: 'recent-unwrapped', lines: RECENT_LINES });
      if (isScrolledUp(recent)) {
        // The reply sits below the viewport (seen after long prompts): scroll, then read again.
        await herdr.sendText(w.paneId, CTRL_END);
        recent = await herdr.read(w.paneId, { source: 'recent-unwrapped', lines: RECENT_LINES });
      }
      const turn = readTurn(recent, w.anchor);
      if (turn.lastLine && turn.lastLine !== lastLine) {
        lastLine = turn.lastLine;
        ctx.progress(Math.min(0.9, (now - started) / w.expectedMs), lastLine);
      }
      const moved = agent.stateChangeSeq > w.seqAtSend;
      const ready = agent.status === 'idle' || agent.status === 'done';
      // A job must never stay running on a Claude that waits (issue #278): ready or at a dialog, its
      // state unmoved since the send for idleNudgeMs, the turn is over though herdr never said so.
      if (ready || agent.status === 'blocked') waitingSince ??= now;
      else waitingSince = null;
      const stalled = !moved && waitingSince !== null && now - waitingSince >= w.idleNudgeMs;
      const park = (o: ExecutionOutcome): ExecutionOutcome => { w.parked?.(agent.stateChangeSeq); return o; };
      if (agent.status === 'blocked' && (moved || !w.blockedAtSend || stalled)) return park(await blockedQuestion(w, recent));
      const ended = ready && (moved || stalled);
      if (!ended) idleSince = null;
      else if (!moved && !turn.anchorFound) return { lostSend: true };
      else if (turn.lastMarker === 'done') {
        return { kind: 'finished', result: { summary: turn.assistantText.slice(0, SUMMARY_CHARS), paneId: w.paneId } };
      } else if (turn.lastMarker === 'failed') {
        return { kind: 'failed', error: turn.failedReason || 'HOPPER_FAILED without a reason' };
      } else if (turn.lastMarker === 'question') {
        return park({ kind: 'question', question: { text: turn.assistantText, recentOutput: tail(recent, OUTPUT_LINES), detectedBy: 'marker' } });
      } else {
        idleSince ??= now;
        if (stalled || now - idleSince >= w.idleNudgeMs) return { statusNote: turn.assistantText };
      }
      errors = 0;
    } catch (err) {
      if (++errors >= MAX_CONSECUTIVE_ERRORS) return { kind: 'failed', error: `herdr: ${(err as Error).message}` };
    }
    await w.sleep(w.pollMs, ctx.signal);
  }
}
