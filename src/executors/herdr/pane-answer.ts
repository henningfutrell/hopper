// The owner answered a job on a question in its pane, not the UI (design.md "Questions" → "Answered in the pane"):
// what the pane shows of it, read for the herdr-claude executor's `answeredInPane`.
// A job waiting on its own background command (issue #1037): whether its pane still shows that command run.
// The job's terminal (issue #1128): its pane's screen for a person, and their input to it.
import type { Clock, Executor, PaneAnswer } from '../../domain/ports.ts';
import type { PaneSession } from '../../domain/terminal.ts';
import type { HerdrClient } from './client.ts';
import { RECENT_LINES } from './monitor.ts';
import { lastLineOf, paneStateOf } from './panes.ts';
import { backgroundWork, readTurn, typedAfterQuestion } from './screen.ts';
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
  // A seq move alone may be herdr's own idle/done flip; working, or a typed echo, is the owner. Past its own wait (issue
  // #483), new output is Claude gone on by itself, though its turn may be over by the time it is looked at.
  const wentOn = typed === undefined && s.turn.markersAfter !== undefined && readTurn(recent, s.turn.anchor).outputLines > s.turn.markersAfter;
  if (agent.status !== 'working' && typed === undefined && !wentOn) return null;
  // Claude went on by itself in the same turn (issue #483): the wait it took stays left out.
  const turn: TurnAnchor = typed
    ? { seq: stopped, anchor: lastLineOf(typed), blockedAtSend: false }
    : { seq: stopped, anchor: s.turn.anchor, blockedAtSend: false, ...(s.turn.markersAfter !== undefined ? { markersAfter: s.turn.markersAfter } : {}) };
  const { parkedSeq: _drop, lapsesAt, ...rest } = s;
  // Nothing typed, and the dialog's countdown has run out: Claude Code denied it by itself, nobody answered (issue #376).
  const lapsed = typed === undefined && lapsesAt !== undefined && clock.now().getTime() >= Date.parse(lapsesAt) - LAPSE_SLACK_MS;
  if (lapsed) return { lapsed: true, executorState: { ...rest, turn } };
  return { ...(typed ? { answer: typed } : {}), executorState: { ...rest, turn } };
}

/**
 * A job waiting on its own background command (issue #1037): true while its agent and pane live and the footer names
 * background work; false when it names none, or the agent or pane is gone; null when herdr does not answer.
 */
async function ownCommandRunsIn(herdr: HerdrClient, s: Pick<PaneState, 'agentName' | 'paneId'>): Promise<boolean | null> {
  try {
    const agent = await herdr.getAgent(s.agentName);
    if (!agent || agent.paneId !== s.paneId) return false;
    return backgroundWork(await herdr.read(s.paneId, { source: 'recent-unwrapped', lines: RECENT_LINES })) !== undefined;
  } catch {
    return null;
  }
}

/** The executor's probes of a job waiting on its own command (issue #1037): whether it still runs, and its one nudge. */
export function ownCommandProbes(herdrOn: (s: PaneState) => HerdrClient): Required<Pick<Executor, 'ownCommandRuns' | 'nudgeInPane'>> {
  return {
    ownCommandRuns: (job) => {
      const s = paneStateOf(job);
      // herdrOn throws for a client target out of reach: that cannot be told now.
      return s ? Promise.resolve().then(() => ownCommandRunsIn(herdrOn(s), s)).catch(() => null) : Promise.resolve(false);
    },
    nudgeInPane: (job, text) => {
      const s = paneStateOf(job);
      return s ? Promise.resolve().then(() => herdrOn(s).prompt(s.agentName, text)).then(() => true, () => false) : Promise.resolve(false);
    },
  };
}

/** The job's terminal (issue #1128): what its pane shows, and a person's text or keys to it, on the pane's own herdr. */
export function terminalProbes(herdrOn: (s: PaneState) => HerdrClient): Required<Pick<Executor, 'paneScreen' | 'typeInPane'>> {
  return {
    paneScreen: async (job, lines) => {
      const s = paneStateOf(job);
      return s ? herdrOn(s).read(s.paneId, { source: 'recent', lines }) : undefined;
    },
    typeInPane: async (job, input) => {
      const s = paneStateOf(job);
      if (!s) return false;
      const herdr = herdrOn(s);
      if ('text' in input) await herdr.sendText(s.paneId, input.text);
      else await herdr.sendKeys(s.paneId, input.keys);
      return true;
    },
  };
}

/** The machine's terminal (issue #1128): every pane of the herdr session, on the herdr the machine is reached by. */
export function paneSessionOn(herdr: HerdrClient): PaneSession {
  return {
    panes: () => herdr.listPanes(),
    read: (paneId, lines) => herdr.read(paneId, { source: 'recent', lines }),
    type: async (paneId, input) => {
      if ('text' in input) await herdr.sendText(paneId, input.text);
      else await herdr.sendKeys(paneId, input.keys);
    },
  };
}
