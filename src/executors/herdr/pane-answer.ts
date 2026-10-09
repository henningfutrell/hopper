// The owner answered a job on a question in its pane, not the UI (design.md "Questions" → "Answered in the pane"):
// what the pane shows of it, read for the herdr-claude executor's `answeredInPane`.
import type { Clock, PaneAnswer } from '../../domain/ports.ts';
import type { HerdrClient } from './client.ts';
import { RECENT_LINES } from './monitor.ts';
import { lastLineOf } from './panes.ts';
import { typedAfterQuestion } from './screen.ts';
import type { PaneState, TurnAnchor } from './start.ts';

/**
 * How early a dialog may count as lapsed (issue #376): its countdown is read when the turn stops on the question, in whole
 * seconds and up to a poll after the dialog showed, so Claude Code's own deadline can come a little sooner.
 */
const LAPSE_SLACK_MS = 5000;

/** The typed answer (if readable) and the state to reattach with, once Claude moved past the turn that stopped on the question; null while it still waits. */
export async function readPaneAnswer(herdr: HerdrClient, s: PaneState & { turn: TurnAnchor }, clock: Clock): Promise<PaneAnswer | null> {
  const agent = await herdr.getAgent(s.agentName);
  if (!agent || agent.paneId !== s.paneId) return null;
  // Stopped before parkedSeq was saved: the send's seq (the turn had already ended past it).
  const stopped = s.parkedSeq ?? s.turn.seq;
  if (agent.stateChangeSeq <= stopped) return null;
  // A dialog before the job's text was sent (issue #534): Claude past it is the answer; reattach sends the text.
  if (s.turn.unsent) {
    if (agent.status === 'blocked') return null;
    const { parkedSeq: _seq, lapsesAt: _at, ...kept } = s;
    return { executorState: { ...kept } };
  }
  const recent = await herdr.read(s.paneId, { source: 'recent-unwrapped', lines: RECENT_LINES });
  const typed = typedAfterQuestion(recent, s.turn.anchor);
  // A seq move alone may be herdr's own idle/done flip; working, or a typed echo, is the owner.
  if (agent.status !== 'working' && typed === undefined) return null;
  const turn: TurnAnchor = { seq: stopped, anchor: typed ? lastLineOf(typed) : s.turn.anchor, blockedAtSend: false };
  const { parkedSeq: _drop, lapsesAt, ...rest } = s;
  // Nothing typed, and the dialog's countdown has run out: Claude Code denied it by itself, nobody answered (issue #376).
  const lapsed = typed === undefined && lapsesAt !== undefined && clock.now().getTime() >= Date.parse(lapsesAt) - LAPSE_SLACK_MS;
  if (lapsed) return { lapsed: true, executorState: { ...rest, turn } };
  return { ...(typed ? { answer: typed } : {}), executorState: { ...rest, turn } };
}
