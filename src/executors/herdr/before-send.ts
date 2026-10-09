// Claude at a dialog when the hopper has text to send. A dialog of the turn in flight is dismissed (the answer named
// none of its options). Any other — before the hopper's text reached Claude — is never a failure (issue #534): one the
// hopper may answer at startup is answered; any other is the job's question, its choices with it, the pane kept; the
// answer is typed into the dialog, and the text goes once Claude is past it. docs/design.md "A dialog before the send".

import type { ExecutionContext, ExecutionOutcome } from '../../domain/ports.ts';
import type { AgentInfo } from './client.ts';
import { RECENT_LINES, abortReason, blockedQuestion, type Interrupt } from './monitor.ts';
import { dialogOption, showsDialog } from './screen.ts';
import { selectKeys, selectOf } from './select-dialog.ts';
import { startupAnswer } from './start.ts';
import type { PaneState, StartDeps } from './start.ts';

/** Looks at a dialog of the turn in flight after esc, before it counts as one esc did not close. */
const UNBLOCK_POLLS = 10;
/** Looks at a blocked Claude before its dialog counts as held: a key just typed may not have closed the last one yet. */
const POLLS = 10;
/** Startup dialogs answered here at most, as at startup. */
const MAX_ANSWERED = 4;

/** Claude ready for the text, gone from its pane, or held at a dialog the hopper may not answer (at `seq`). */
export type PastDialog = { ready: true } | { gone: true } | { held: number };

/**
 * Waits for Claude to leave the dialog it stands at, answering one the hopper may answer at startup (start.ts
 * `startupAnswer`), judged once per state change. Ready once it is not blocked (or the signal fired: the caller checks).
 */
export async function pastDialog(d: StartDeps, ctx: ExecutionContext, s: PaneState): Promise<PastDialog> {
  let answeredAt = -1;
  let answered = 0;
  for (let looks = 1; ; looks++) {
    if (ctx.signal.aborted) return { ready: true };
    const agent = await d.herdr.getAgent(s.agentName);
    if (!agent) return { gone: true };
    if (agent.status !== 'blocked') return { ready: true };
    if (agent.stateChangeSeq !== answeredAt && answered < MAX_ANSWERED) {
      const said = startupAnswer(d, await d.herdr.read(s.paneId, { source: 'visible', lines: 60 }), s.jobWorktree ?? s.cwd);
      if (said) {
        // Each opens on its refusing option; the next one down accepts.
        await d.herdr.sendKeys(s.paneId, ['down', 'enter']);
        ctx.progress(0, said);
        answeredAt = agent.stateChangeSeq;
        answered++;
        looks = 0;
      }
    }
    if (looks >= POLLS) return { held: agent.stateChangeSeq };
    await d.sleep(d.pollMs, ctx.signal);
  }
}

/** The dialog Claude is held at (`seq`), as the job's question; `text` is kept in the turn, unsent, to go once it is answered. */
export async function askAtDialog(d: StartDeps, ctx: ExecutionContext, s: PaneState, seq: number, text: string, anchor: string): Promise<ExecutionOutcome> {
  const recent = await d.herdr.read(s.paneId, { source: 'recent-unwrapped', lines: RECENT_LINES });
  const asked = await blockedQuestion({ herdr: d.herdr, paneId: s.paneId, clock: d.clock }, recent);
  const { lapsesAt } = asked.question;
  ctx.saveState({ ...s, turn: { seq, anchor, blockedAtSend: true, text, unsent: true }, parkedSeq: seq, lapsesAt });
  ctx.progress(0, 'claude waits at a dialog before the prompt was sent: asked it as a question');
  return asked;
}

/**
 * Types the answer into the dialog Claude waits at before its text was sent: the option it names, or, at a dialog
 * without options, the answer and Enter. Null once typed; the question again, saying so, when the dialog has options
 * and the answer names none of them (pressing Enter would pick whichever has the cursor, often the one that quits).
 */
export async function answerDialog(d: StartDeps, ctx: ExecutionContext, s: PaneState, answer: string): Promise<ExecutionOutcome | null> {
  const screen = await d.herdr.read(s.paneId, { source: 'visible', lines: 60 });
  const option = dialogOption(screen, answer);
  if (option) {
    await d.herdr.sendText(s.paneId, option);
    ctx.progress(0, `picked option ${option} of the dialog`);
    return null;
  }
  const picked = selectKeys(screen, answer);
  if (picked) {
    await d.herdr.sendKeys(s.paneId, picked.keys);
    ctx.progress(0, `picked option ${picked.option} of the dialog`);
    return null;
  }
  if (showsDialog(screen) && (dialogOption(screen, '1') !== undefined || selectOf(screen.split('\n')))) {
    const asked = await blockedQuestion({ herdr: d.herdr, paneId: s.paneId, clock: d.clock }, await d.herdr.read(s.paneId, { source: 'recent-unwrapped', lines: RECENT_LINES }));
    ctx.saveState({ ...s });
    return { kind: 'question', question: { ...asked.question, text: `The answer names none of its options: answer with an option's number or its words.\n\n${asked.question.text}` } };
  }
  await d.herdr.sendText(s.paneId, answer);
  await d.herdr.sendKeys(s.paneId, ['enter']);
  ctx.progress(0, 'typed the answer into the dialog');
  return null;
}

/**
 * Claude ready for `text`: its agent to send at, else the end of the run or the dialog asked as the job's question,
 * `text` kept to send once it is answered. A dialog of the turn in flight is dismissed with esc first.
 */
export async function readyFor(d: StartDeps, ctx: ExecutionContext, s: PaneState, text: string, anchor: string): Promise<AgentInfo | ExecutionOutcome | Interrupt> {
  let agent = await d.herdr.getAgent(s.agentName);
  for (let i = 0; agent?.status === 'blocked' && s.turn && !s.turn.unsent && i < UNBLOCK_POLLS; i++) {
    if (i === 0) await d.herdr.sendKeys(s.paneId, ['esc']);
    await d.sleep(d.pollMs, ctx.signal);
    if (ctx.signal.aborted) return { interrupt: abortReason(ctx.signal) };
    agent = await d.herdr.getAgent(s.agentName);
  }
  if (agent?.status === 'blocked') {
    const past = await pastDialog(d, ctx, s);
    if (ctx.signal.aborted) return { interrupt: abortReason(ctx.signal) };
    if ('held' in past) return askAtDialog(d, ctx, s, past.held, text, anchor);
    agent = 'gone' in past ? null : await d.herdr.getAgent(s.agentName);
  }
  return agent ?? { kind: 'failed', error: 'pane lost' };
}
