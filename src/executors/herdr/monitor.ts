// Watches one Claude turn in its pane until an outcome: the polling half of the executor.
// docs/design.md "Phase 2" → "Monitor" and "Turn anchor (B1)".

import type { Clock, ExecutionContext, ExecutionOutcome } from '../../domain/ports.ts';
import type { LoginCheck } from '../../domain/types.ts';
import { hideCodes } from '../../logins/recognise.ts';
import { loginSignalIn, type LoginSignal } from '../../logins/signals.ts';
import type { HerdrClient } from './client.ts';
import { CTRL_END, afterLoginReport, autoDenyMs, backgroundWork, dialogText, inputBoxText, isScrolledUp, readTurn, type AuthFields } from './screen.ts';

export const RECENT_LINES = 200;
const OUTPUT_LINES = 120;
export const SUMMARY_CHARS = 4000;
const MAX_CONSECUTIVE_ERRORS = 3;

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** Why the turn stopped without an outcome; the executor decides what to do with the pane. */
export type Interrupt = { interrupt: 'cancel' | 'park' | 'shutdown' | 'timeout' };

/**
 * The turn ended without a marker (issue #163): progress, never a question. The executor nudges. Never while
 * the footer names background work the job started (issue #491): Claude Code wakes the job when it ends.
 */
export type StatusNote = { statusNote: string };

/** The turn ended on a login (issue #476): the executor reports it to the logins; never a question. */
export type AuthPending = { authPending: AuthFields };

/** The user acted on the login the job waits on (issue #476): a new code, a cancel, or the job fails. */
export type LoginActed = { login: Exclude<LoginCheck, { act: 'wait' } | { act: 'ended' }> };

/**
 * The login a watch waits on (issue #476): what the user did with it, and a login signal on screen (issue #567).
 * Claude going on by itself is no signal: a device-flow script that polls wakes it again and again.
 */
export interface LoginWait {
  check(): LoginCheck;
  /** A login signal shown after the login's report: once per signal shown. `completed` and `denied` end the wait. */
  signal(s: LoginSignal): void;
}

/**
 * A lost send (issue #278): Claude has sat ready since the send, its state never moved, and the turn
 * anchor is nowhere on screen or the text sits unsent in its input box. What was sent never reached
 * Claude; the executor submits the input box, or sends it again.
 */
export type LostSend = { lostSend: true };

export interface TurnWatch {
  herdr: HerdrClient;
  clock: Clock;
  sleep: Sleep;
  pollMs: number;
  /** How long the turn sits idle without a marker, and no background work running, before it counts as a status note. */
  idleNudgeMs: number;
  /** How long Claude may sit waiting with its state unmoved since the send before the turn counts as over all the same. */
  stallMs: number;
  /**
   * The turn counts as over only once Claude has worked in this watch (issue #491): the hopper sent nothing,
   * and waits for Claude to go on by itself, woken by a background notification or a person in its pane.
   */
  untilWorking?: boolean;
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
  /** Called with state_change_seq when the turn stops on a question, before the outcome returns; with when its dialog lapses, if it does. */
  onQuestion?: (seq: number, lapsesAt?: string) => void;
  /** The login the job waits on (issue #476), with `untilWorking`: Claude going on completes it. */
  login?: LoginWait;
  /** Called with the time the turn's output changed, each time it does (issue #630): a timed-out job's liveness. */
  onOutput?: (at: number) => void;
}

export function abortReason(signal: AbortSignal): 'cancel' | 'park' | 'shutdown' {
  return signal.reason === 'shutdown' || signal.reason === 'park' ? signal.reason : 'cancel';
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

/** The dialog Claude waits at, as the job's question; `recent` is what led up to it. */
export async function blockedQuestion(w: Pick<TurnWatch, 'herdr' | 'paneId' | 'clock'>, recent: string): Promise<ExecutionOutcome & { kind: 'question' }> {
  const visible = await w.herdr.read(w.paneId, { source: 'visible', lines: 60 });
  // The question is the dialog itself (issue #377); what led up to it is the recent output.
  const text = dialogText(visible) || tail(visible, 30);
  // Claude Code may deny the dialog by itself when a countdown runs out (issue #376).
  const ms = autoDenyMs(text);
  const lapsesAt = ms === undefined ? {} : { lapsesAt: new Date(w.clock.now().getTime() + ms).toISOString() };
  return { kind: 'question', question: { text: hideCodes(text, recent), recentOutput: hideCodes(tail(recent, OUTPUT_LINES), recent), detectedBy: 'blocked', ...lapsesAt } };
}

export async function watchTurn(w: TurnWatch): Promise<ExecutionOutcome | Interrupt | StatusNote | LostSend | AuthPending | LoginActed> {
  const { herdr, clock, ctx } = w;
  const started = w.startedAt ?? clock.now().getTime();
  let lastLine = '';
  /** The turn's output as last seen: its lines and its last line. */
  let lastOutput = '';
  let idleSince: number | null = null;
  let waitingSince: number | null = null;
  let worked = w.untilWorking !== true;
  /** Under `untilWorking`, the turn on screen when the watch began: new output is work too, though no poll saw Claude working. */
  let atStart: { text: string; lines: number } | undefined;
  /** The background work last reported as waited on, so it is reported once. */
  let waitedOn: string | undefined;
  let errors = 0;
  /** The login this watch waits on, until a signal ends it; the last signal it was given. */
  let login = w.login;
  let signalled: LoginSignal | undefined;
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
      const output = `${turn.outputLines}\n${turn.lastLine}`;
      if (turn.lastLine && output !== lastOutput) { lastOutput = output; w.onOutput?.(now); }
      if (turn.lastLine && turn.lastLine !== lastLine) {
        lastLine = turn.lastLine;
        // A device code on screen never goes into progress (issue #476).
        ctx.progress(Math.min(0.9, (now - started) / w.expectedMs), hideCodes(lastLine, recent));
      }
      atStart ??= { text: turn.assistantText, lines: turn.outputLines };
      if (agent.status === 'working' || turn.assistantText !== atStart.text || turn.outputLines !== atStart.lines) worked = true;
      if (login) {
        const said = login.check();
        if (said.act === 'ended') login = undefined;
        else if (said.act !== 'wait') return { login: said };
      }
      const signal = login ? loginSignalIn(afterLoginReport(recent, w.anchor)) : undefined;
      if (login && signal && signal !== signalled) {
        signalled = signal;
        login.signal(signal);
        if (signal !== 'expired') login = undefined;
      }
      const moved = agent.stateChangeSeq > w.seqAtSend;
      const ready = agent.status === 'idle' || agent.status === 'done';
      // A job must never stay running on a Claude that waits (issue #278): ready or at a dialog, its
      // state unmoved since the send for idleNudgeMs, the turn is over though herdr never said so.
      if (ready || agent.status === 'blocked') waitingSince ??= now;
      else waitingSince = null;
      const stalled = !moved && waitingSince !== null && now - waitingSince >= w.stallMs;
      const asked = (o: ExecutionOutcome): ExecutionOutcome => { w.onQuestion?.(agent.stateChangeSeq, o.kind === 'question' ? o.question.lapsesAt : undefined); return o; };
      if (agent.status === 'blocked' && (moved || !w.blockedAtSend || stalled)) return asked(await blockedQuestion(w, recent));
      const ended = worked && ready && (moved || stalled);
      if (!ended) { idleSince = null; waitedOn = undefined; }
      else if (!moved && (!turn.anchorFound || inputBoxText(recent) !== '')) return { lostSend: true };
      else if (turn.lastMarker === 'done') {
        return { kind: 'finished', result: { summary: hideCodes(turn.assistantText, recent).slice(0, SUMMARY_CHARS), paneId: w.paneId } };
      } else if (turn.lastMarker === 'failed') {
        return { kind: 'failed', error: hideCodes(turn.failedReason || 'HOPPER_FAILED without a reason', recent), tail: hideCodes(tail(recent, OUTPUT_LINES), recent) };
      } else if (turn.lastMarker === 'question') {
        return asked({ kind: 'question', question: { text: hideCodes(turn.assistantText, recent), recentOutput: hideCodes(tail(recent, OUTPUT_LINES), recent), detectedBy: 'marker' } });
      } else if (turn.lastMarker === 'proposal' || turn.lastMarker === 'research') {
        // A proposal or a research report (issues #537, #543) waits like a question: the job resumes in this pane with the decision.
        return asked({ kind: 'report', review: turn.lastMarker, report: { text: hideCodes(turn.assistantText, recent), recentOutput: hideCodes(tail(recent, OUTPUT_LINES), recent) } });
      } else if (turn.lastMarker === 'auth') {
        return { authPending: turn.auth ?? {} };
      } else {
        const work = backgroundWork(recent);
        if (work) {
          idleSince = null;
          if (work !== waitedOn) ctx.progress(Math.min(0.9, (now - started) / w.expectedMs), `waiting on background work (${work}): no nudge while it runs`);
          waitedOn = work;
        } else {
          waitedOn = undefined;
          idleSince ??= now;
          if (stalled || now - idleSince >= w.idleNudgeMs) return { statusNote: hideCodes(turn.assistantText, recent) };
        }
      }
      errors = 0;
    } catch (err) {
      if (++errors >= MAX_CONSECUTIVE_ERRORS) return { kind: 'failed', error: `herdr: ${(err as Error).message}` };
    }
    await w.sleep(w.pollMs, ctx.signal);
  }
}
