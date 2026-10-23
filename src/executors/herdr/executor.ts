// The herdr-claude executor: one Claude Code job per herdr tab, driven through the screen
// protocol. docs/design.md "Phase 2" → "herdr-claude executor".

import type { Clock, ExecutionContext, ExecutionOutcome, Executor, Reaped } from '../../domain/ports.ts';
import type { Job, LaneId, MachineSnapshot } from '../../domain/types.ts';
import { HerdrError, type HerdrClient } from './client.ts';
import { RECENT_LINES, abortReason, tail, watchTurn } from './monitor.ts';
import { LOST_NOTE, outsideItsPane, RELEASED_NOTE, RESTORED_NOTE, restartInNewPane, resumeLostPane } from './restored.ts';
import { afterStatusNote, nudgeGapMs } from './nudge.ts';
import type { Interrupt, Sleep } from './monitor.ts';
import { afterLoginAct, loginWait, restoreLogin, takeLogin } from './login.ts';
import { resolvePayload, validatePayload, workTreeOn } from './payload.ts';
import type { ClaudeJobPayload } from './payload.ts';
import { FOOTER_ANCHOR, STATUS_NOTE_NUDGE, dialogOption, inputBoxText } from './screen.ts';
import { ownCommandProbes, paneLostProbe, paneSessionOn, readPaneAnswer, terminalProbes } from './pane-answer.ts';
import { checkpointOn, payloadOn, relocation, taskText } from './relocate.ts';
import { answerDialog, readyFor } from './before-send.ts';
import { paneEnds } from './pane-ends.ts'; import { paneLeft } from './pane-left.ts'; import { paneOpen } from './pane-open.ts';
import { jobScratchOf, startInPane, type PaneState, type StartDeps, type TurnAnchor } from './start.ts';
import { heldElsewhere, heldOf, lastLineOf, paneStateOf, realSleep, samePane, whereOn, type HeldPane, type RemoteHerdr, type Where } from './panes.ts';

export type { ClientTarget, RemoteHerdr } from './panes.ts';

/** Sends of one text that never reach Claude (lost sends, issue #278) before the job fails. */
const MAX_SENDS = 3;

export interface HerdrClaudeExecutorOptions {
  /** This machine's herdr. */
  herdr: HerdrClient;
  /** The herdr of an attached machine. Absent → jobs on one fail. */
  remote?: (there: RemoteHerdr) => HerdrClient;
  /** Another herdr session on this machine: the one this machine was added with (issue #260). Absent → `herdr`'s. */
  local?: (session: string) => HerdrClient;
  clock: Clock;
  /** Claude's arguments as it starts: `claudeArgsFor(yolo, args)`. */
  claudeArgs: string[];
  trustWorkdir: boolean;
  /** Claude starts with every permission granted (issue #267): its warning is accepted at startup. Default false. */
  yolo?: boolean;
  /** Claude's config seeded where the machine has none, its first-run screens answered with their defaults (issue #533). Default false. */
  unattended?: boolean;
  /** Each job its own git worktree of a work tree that is a git repository's top, in its scratch dir (issue #379). Default false. */
  jobWorktrees?: boolean;
  /** A job worktree's node_modules linked to dependencies shared with the repository's other jobs (issue #410). Default false. */
  sharedDependencies?: boolean;
  pollMs: number;
  /** Idle without a marker this long, a turn is a status note and the agent is nudged; further ones in a row wait NUDGE_GAPS_MS. */
  idleNudgeMs: number;
  /** How long Claude's input box stays on screen at startup before Claude is taken as ready (issue #533). Default 2000. */
  promptSteadyMs?: number;
  /** Set on the tab of a job in this machine's herdr: the user's CLI config dirs (issue #158). Default none. */
  paneEnv?: Readonly<Record<string, string>>;
  /** Injectable for tests; default an abortable setTimeout. */
  sleep?: Sleep;
  /** Spreads the pause before a start is tried again; default Math.random. */
  random?: () => number;
}

export interface HerdrClaudeExecutor extends Executor {
  /** laneId → paneId for the job now running on that lane. */
  lanePanes(): ReadonlyMap<LaneId, string>;
}

export function createHerdrClaudeExecutor(o: HerdrClaudeExecutorOptions): HerdrClaudeExecutor {
  const { clock } = o;
  const sleep = o.sleep ?? realSleep;
  const random = o.random ?? Math.random;
  const lanes = new Map<LaneId, HeldPane>();
  /** What the reap kept, by job, until cleanup answers it: a pane closed on cancel or timeout is reaped then. */
  const reaped = new Map<string, Reaped>();
  /** When each running job's pane output last changed (issue #630): at a timeout, its liveness. */
  const outputAt = new Map<string, number>();
  /** Each job's device codes reported or shown so far (issue #698), in memory only: a code on screen is a new login once. */
  const codes = new Map<string, Set<string>>();

  /** The herdr a pane lives on: this machine's, or the attached machine's over ssh. */
  function herdrOn(p: Where): HerdrClient {
    if (p.client) {
      if (!o.remote) throw new Error(`cannot reach client target ${p.client.machine}`);
      return o.remote({ client: p.client });
    }
    if (!p.ssh) return p.session && o.local && p.session !== o.herdr.session ? o.local(p.session) : o.herdr;
    if (!o.remote || !p.session) throw new Error(`cannot reach attached machine ${p.ssh}: no herdr there`);
    return o.remote({ ssh: p.ssh, session: p.session });
  }

  /** The herdr the machine is reached by; undefined when it cannot be reached. */
  const herdrAt = (machine: MachineSnapshot): HerdrClient | undefined => { try { return herdrOn(whereOn(machine)); } catch { return undefined; } };

  const depsOn = (where: Where): StartDeps => ({
    herdr: herdrOn(where), clock, sleep, pollMs: o.pollMs, claudeArgs: o.claudeArgs, trustWorkdir: o.trustWorkdir, yolo: o.yolo ?? false, unattended: o.unattended ?? false,
    jobWorktrees: o.jobWorktrees ?? false, sharedDependencies: o.sharedDependencies ?? false, promptSteadyMs: o.promptSteadyMs,
  });


  // The reap and the close of a job's pane (pane-ends.ts), with the lanes and what the reap kept here.
  const { reap, exitAndClose, settle } = paneEnds({ pollMs: o.pollMs, sleep, herdrOn, reaped, lanes, outputAt });

  /**
   * Nudges so far in a row, and when the turn they belong to began; lost sends of the text in flight; `quiet`
   * once the nudges stopped (issue #491), until Claude works again by itself.
   */
  interface Notes { count: number; startedAt: number; lost?: number; quiet?: boolean; unreadable?: number; steered?: boolean }

  /**
   * Sends `text` as a new turn and watches it, once Claude is ready for it (before-send.ts `readyFor`: a dialog of
   * the turn in flight dismissed, any other asked of a person, issue #534). herdr refusing the prompt because Claude
   * went to a dialog between the look and the send is looked at again, once.
   */
  async function send(ctx: ExecutionContext, s: PaneState, p: ClaudeJobPayload, text: string, anchor: string, notes?: Notes): Promise<ExecutionOutcome | Interrupt> {
    for (let refused = false; ; refused = true) {
      const agent = await readyFor(depsOn(s), ctx, s, text, anchor);
      if (!('stateChangeSeq' in agent)) return agent;
      const turn: TurnAnchor = { seq: agent.stateChangeSeq, anchor, blockedAtSend: agent.status === 'blocked', text };
      // Saved before the prompt: a restart in between watches a turn never sent, which ends as a
      // lost send and is sent again, never as a lost job.
      ctx.saveState({ ...s, turn, parkedSeq: undefined, lapsesAt: undefined });
      const err = await herdrOn(s).prompt(s.agentName, text).then(() => undefined, (e: unknown) => e);
      // A prompt herdr answered too late may have reached Claude (issue #1857): the watch sees the turn, or a lost send.
      if (err === undefined || (err instanceof HerdrError && err.code === 'timeout')) return watch(ctx, s, p, turn, notes);
      if (refused || !(err instanceof HerdrError) || err.code !== 'agent_blocked') throw err;
    }
  }

  /**
   * Watches the turn to its outcome. A status note (issue #163) opens no question: the agent is
   * nudged and the same turn goes on, under the same timeout. A lost send (issue #278) is submitted
   * with Enter when it sits in the input box, else sent again, at most MAX_SENDS times in all; then the
   * job fails, so it never stays running on a waiting Claude.
   */
  // The login the job waits on stays with it through every turn until a login signal or the user ends it (issue #567).
  async function watch(ctx: ExecutionContext, s: PaneState, p: ClaudeJobPayload, turn: TurnAnchor, notes: Notes = { count: 0, startedAt: clock.now().getTime() }, login = s.login): Promise<ExecutionOutcome | Interrupt> {
    const result = await watchTurn({
      herdr: herdrOn(s), clock, sleep, pollMs: o.pollMs, idleNudgeMs: nudgeGapMs(notes.count, o.idleNudgeMs), stallMs: o.idleNudgeMs, untilWorking: notes.quiet, ctx, agentName: s.agentName,
      paneId: s.paneId, ...(s.terminal ? { terminal: s.terminal } : {}), anchor: turn.anchor, seqAtSend: turn.seq, blockedAtSend: turn.blockedAtSend, markersAfter: turn.markersAfter,
      timeoutMs: p.timeoutMs, startedAt: notes.startedAt,
      onQuestion: (seq, lapsesAt, waitLines) => ctx.saveState({ ...s, turn: waitLines === undefined ? turn : { ...turn, markersAfter: waitLines }, parkedSeq: seq, lapsesAt }),
      onOutput: (at) => outputAt.set(ctx.job.id, at), knownCodes: codes.get(ctx.job.id) ?? codes.set(ctx.job.id, new Set()).get(ctx.job.id)!,
      ...(login ? { login: loginWait(ctx, login, () => ctx.saveState({ ...s, login: undefined })) } : {}),
      ...(ctx.notes ? { notesWaiting: ctx.notes.waiting } : {}),
    });
    if ('paneRestored' in result) return restartRestored(ctx, s, p, RESTORED_NOTE, result.agentPane);
    if ('notes' in result) {
      // A person's notes at the turn boundary (issue #997): typed in as the next turn, the job's own outcome left to it.
      const text = ctx.notes?.take('turn');
      if (text === undefined) return watch(ctx, s, p, turn, notes, login);
      ctx.progress('typed in the notes a person sent');
      return send(ctx, s, p, text, lastLineOf(text), { count: 0, startedAt: notes.startedAt });
    }
    if ('authPending' in result) {
      // A login (issue #476): to the logins, never a question; the job waits, no nudge, for Claude to go on by itself.
      const unreadable = (notes.unreadable ?? 0) + 1;
      const taken = takeLogin(ctx, result.authPending, clock.now(), unreadable, notes.steered === true, login, { seen: result.seen === true, codes: codes.get(ctx.job.id) });
      if ('failed' in taken) return { kind: 'failed', error: taken.failed };
      // A GitHub login steered to the hopper (issue #563): the same login reported next fails the job (issue #695).
      if ('say' in taken) return send(ctx, taken.login ? { ...s, login: taken.login } : s, p, taken.say, lastLineOf(taken.say), { count: notes.count, startedAt: notes.startedAt, ...(taken.steered ? { steered: true } : { unreadable }) });
      const waiting = { ...s, turn, login: taken.login, parkedSeq: undefined, lapsesAt: undefined };
      ctx.saveState(waiting);
      return watch(ctx, waiting, p, turn, { count: 0, startedAt: notes.startedAt, quiet: true });
    }
    if ('login' in result) {
      // The user acted on the login the job waits on (issue #476).
      const next = afterLoginAct(result.login, login?.tool ?? 'the');
      if ('failed' in next) return { kind: 'failed', error: next.failed };
      ctx.progress(next.progress);
      return send(ctx, { ...s, login: undefined }, p, next.say, lastLineOf(next.say), { count: 0, startedAt: notes.startedAt });
    }
    if ('lostSend' in result) {
      const herdr = herdrOn(s);
      const sends = (notes.lost ?? 0) + 1;
      const screen = await herdr.read(s.paneId, { source: 'visible', lines: 40 }).catch(() => '');
      const unsent = inputBoxText(screen) !== '';
      if (sends >= MAX_SENDS || (!unsent && turn.text === undefined)) {
        return { kind: 'failed', error: `the prompt never reached claude${turn.text === undefined && !unsent ? '' : ` after ${sends} sends`}: ${tail(screen, 20)}` };
      }
      const again = { ...notes, lost: sends };
      if (!unsent) {
        ctx.progress('the prompt never reached claude: sent it again');
        return send(ctx, s, p, turn.text!, turn.anchor, again);
      }
      // Pasted but never submitted (seen live): Enter submits it; sending it again would paste it twice.
      const agent = await herdr.getAgent(s.agentName);
      if (!agent) return { kind: 'failed', error: 'pane lost' };
      const next: TurnAnchor = { ...turn, seq: agent.stateChangeSeq };
      ctx.saveState({ ...s, turn: next, parkedSeq: undefined, lapsesAt: undefined });
      await herdr.sendKeys(s.paneId, ['enter']);
      ctx.progress("the prompt sat unsent in claude's input: submitted it");
      return watch(ctx, s, p, next, again);
    }
    if (!('statusNote' in result)) return result;
    // The source state first (issue #627): a job whose work is over there ends done; one that waits on a person is not nudged.
    const next = await afterStatusNote(notes, ctx, { ...result, paneId: s.paneId });
    if (!('nudges' in next)) return 'ended' in next ? next.ended : watch(ctx, s, p, turn, { count: notes.count, startedAt: notes.startedAt, quiet: true });
    return send(ctx, s, p, STATUS_NOTE_NUDGE, STATUS_NOTE_NUDGE, { count: next.nudges, startedAt: notes.startedAt });
  }

  /** The saved pane, with its turn, when Claude still runs in that pane. */
  async function liveTurn(job: Job): Promise<(PaneState & { turn: TurnAnchor }) | undefined> {
    const state = paneStateOf(job);
    if (!state?.turn) return undefined;
    const agent = await herdrOn(state).getAgent(state.agentName);
    return agent?.paneId === state.paneId ? { ...state, turn: state.turn } : undefined;
  }

  /** Runs `body` with the lane mapped to the pane; never rejects; on error the pane is released. */
  async function onLane(ctx: ExecutionContext, getPane: () => HeldPane | undefined, body: () => Promise<ExecutionOutcome | Interrupt>): Promise<ExecutionOutcome> {
    try {
      const result = await body();
      const pane = getPane();
      return pane ? await settle(result, pane) : ('interrupt' in result ? { kind: 'failed', error: 'aborted' } : result);
    } catch (err) {
      const pane = getPane();
      if (pane && !(ctx.signal.aborted && abortReason(ctx.signal) !== 'cancel')) await exitAndClose(pane);
      return { kind: 'failed', error: `herdr: ${(err as Error).message}` };
    } finally {
      const held = lanes.get(ctx.laneId);
      const pane = getPane();
      if (held && pane && samePane(held, pane)) lanes.delete(ctx.laneId);
    }
  }

  /** Open the job's pane in `p.cwd` and start Claude there (start.ts `startInPane`); `held` learns each pane, for onLane. */
  function startIn(ctx: ExecutionContext, p: ClaudeJobPayload, held: (s: PaneState | undefined) => void, resume?: string, restore?: string): Promise<PaneState | ExecutionOutcome | Interrupt> {
    const where = whereOn(ctx.machine);
    const local = !where.ssh && !where.client;
    return startInPane(depsOn(where), ctx, p, {
      // The job acts through its source's connection (issue #214), never through its payload: its token kept
      // current in the job's credentials dir on the machine, the pane's environment pointing there (issue #441).
      env: async () => {
        const env = { ...p.env, ...(await ctx.credentials?.(jobScratchOf(p.cwd, ctx.job.id), p.makeWorkTree)) };
        return local ? { ...env, ...o.paneEnv } : env;
      },
      opened: (s) => {
        const refused = heldElsewhere(lanes, ctx.laneId, s);
        if (refused) return refused;
        held(s);
        lanes.set(ctx.laneId, heldOf(s, ctx.job.id));
        return null;
      },
      close: async (s) => { await exitAndClose(heldOf(s, ctx.job.id)); held(undefined); },
      random, ...(resume ? { resume } : {}), ...(restore ? { restore } : {}),
    });
  }

  /**
   * A parked job re-queued (issue #501): whatever of it still runs on its machine is stopped first — two agents in
   * one session would interleave —, then a new pane opens in its work tree, Claude resumes its recorded session
   * there (its worktree found where it was left), and the answer goes to it. With none recorded (issue #530), a fresh
   * session starts there instead, sent its task, `answer` (the engine's brief: its question and answer) and the footer.
   */
  /**
   * Opens the job's pane and starts Claude (`resume`: its session; `restore`: its checkpoint first, issue #921), says
   * `said`, then sends the text `text` gives for the pane, with its anchor.
   */
  function startAndSend(ctx: ExecutionContext, p: ClaudeJobPayload, o: { resume?: string; restore?: string; said?: string; first?: () => Promise<unknown> }, text: (s: PaneState) => [string, string]): Promise<ExecutionOutcome> {
    let state: PaneState | undefined;
    return onLane(ctx, () => state && heldOf(state, ctx.job.id), async () => {
      await o.first?.();
      const started = await startIn(ctx, p, (s) => { state = s; }, o.resume, o.restore);
      if ('kind' in started || 'interrupt' in started) return started;
      if (o.said) ctx.progress(o.said);
      return send(ctx, started, p, ...text(started));
    });
  }

  /** A pane herdr restored (restored.ts, issue #1465): its Claude stopped, then resumed in a new pane, told `text`. */
  const restartRestored = (ctx: ExecutionContext, s: PaneState, p: ClaudeJobPayload, text: string, agentPane?: string): Promise<ExecutionOutcome> =>
    restartInNewPane({ exitAndClose: (pane) => exitAndClose(pane, 'none'), startAndSend }, ctx, s, p, text, agentPane);

  /** The answer a job resumes with, and after it the notes a person sent while it waited (issue #997). */
  function withNotes(ctx: ExecutionContext, answer: string): string {
    const notes = ctx.notes?.take('resume');
    return notes === undefined ? answer : `${answer}\n\n${notes}`;
  }

  function reopen(ctx: ExecutionContext, saved: PaneState | undefined, answer: string): Promise<ExecutionOutcome> {
    if (ctx.job.parked?.elsewhere) return relocate(ctx, answer, saved);
    // No pane state (issue #1472): Push it reopens the job worktree its kept work names, in a fresh session.
    const where = saved ?? ctx.keptTree;
    const session = saved ? ctx.job.agentSession : undefined;
    if (!where) return Promise.resolve({ kind: 'failed', error: 'the parked job has no pane state: its work tree is not known' });
    const told = withNotes(ctx, answer);
    const p = { ...resolvePayload(ctx.job, ctx.machine), cwd: where.cwd, makeWorkTree: false };
    ctx.workTree(where.jobWorktree ?? where.cwd);
    return startAndSend(ctx, p, {
      first: () => herdrOn(whereOn(ctx.machine)).reap(ctx.job.id), ...(session ? { resume: session } : {}),
      said: session ? `resumed agent session ${session}` : 'started a fresh agent session in the kept work tree: none was recorded',
    }, (s) => (session ? [told, lastLineOf(told)] : [taskText(ctx, p, s, told), FOOTER_ANCHOR]));
  }

  /**
   * A parked job picked up to resume elsewhere (issue #921): a new pane and job worktree there, its checkpoint restored, its
   * session resumed. Text the old pane held unsent behind a dialog (a not-signed-in Claude's, issue #1211) goes after the answer.
   */
  function relocate(ctx: ExecutionContext, answer: string, saved: PaneState | undefined): Promise<ExecutionOutcome> {
    const r = relocation(ctx);
    if ('kind' in r) return Promise.resolve(r);
    ctx.workTree(r.p.cwd);
    const unsent = saved?.turn?.unsent ? saved.turn.text : undefined;
    const text = withNotes(ctx, unsent ? `${answer}\n\n${unsent}` : answer);
    // Back on a machine it left (issue #1569): what of it still runs there stops first.
    // A patch that applied only in part (issue #2428): the agent is told first what of its work is not in the work tree.
    return startAndSend(ctx, r.p, { first: () => herdrOn(whereOn(ctx.machine)).reap(ctx.job.id), resume: r.session, restore: r.restore, said: r.said }, (s) => [s.restoreNote ? `${s.restoreNote}\n\n${text}` : text, lastLineOf(text)]);
  }

  return {
    name: 'herdr-claude',
    idempotent: false,
    reviews: true,
    lanePanes: () => new Map([...lanes].map(([lane, held]) => [lane, held.paneId])),
    validate: validatePayload,

    async run(ctx) {
      const p = payloadOn(ctx);
      if ('kind' in p) return p;
      ctx.workTree(p.cwd);
      // Notes a person sent before it started (issue #997) go in its task.
      return startAndSend(ctx, p, {}, (s) => [taskText(ctx, p, s, ctx.notes?.take('start')), FOOTER_ANCHOR]);
    },

    // The `job-run` saga's steps (issue #1662): the credentials, then the pane, then `reattach` sends the task and watches it.
    ...paneOpen({ onLane, startIn, exitAndClose }),

    resume(ctx, answer) {
      const state = paneStateOf(ctx.job);
      // A failed job a person continued (issue #551) left no pane either: its session reopens in its work tree as a parked one's.
      // So does one whose agent ended on its wait to free memory (issue #2303), told why first.
      if (ctx.job.parked || ctx.job.continued || ctx.job.waitReleased) return reopen(ctx, state, ctx.job.waitReleased ? `${RELEASED_NOTE}\n\n${answer}` : answer);
      if (!state) return Promise.resolve({ kind: 'failed', error: 'pane lost' });
      const p = resolvePayload(ctx.job, ctx.machine);
      const refused = heldElsewhere(lanes, ctx.laneId, state);
      if (refused) return Promise.resolve(refused);
      return onLane(ctx, () => state && heldOf(state, ctx.job.id), async () => {
        const herdr = herdrOn(state);
        const agent = await herdr.getAgent(state.agentName);
        // Lost while it waited (issue #1508): the answer goes to Claude resumed in a new pane.
        if (!agent) return resumeLostPane({ exitAndClose: (pane) => exitAndClose(pane, 'none'), startAndSend }, ctx, { ...state, laneId: ctx.laneId }, p, `${LOST_NOTE}\n\n${withNotes(ctx, answer)}`);
        // Restored by herdr while the job waited (issue #1465), or resumed by it in another pane (issue #2320): the answer
        // goes to Claude resumed in a new pane, never to a shell without the job's variables.
        if (outsideItsPane(agent, state)) return restartRestored(ctx, { ...state, laneId: ctx.laneId }, p, `${RESTORED_NOTE}\n\n${withNotes(ctx, answer)}`, agent.paneId);
        lanes.set(ctx.laneId, heldOf(state, ctx.job.id));
        const s = { ...state, laneId: ctx.laneId };
        // The question was a dialog before the job's text reached Claude (issue #534): the answer goes into the
        // dialog, then the text.
        if (s.turn?.unsent) return (await answerDialog(depsOn(s), ctx, s, answer, agent.status === 'blocked')) ?? send(ctx, s, p, s.turn.text ?? answer, s.turn.anchor);
        // Claude waits at a dialog (a permission it asks for without yolo, issue #267) and the answer
        // names one of its options: pick it, and the parked turn goes on. Any other answer dismisses
        // the dialog and goes to Claude as text.
        const option = agent.status === 'blocked' && s.turn
          ? dialogOption(await herdr.read(s.paneId, { source: 'visible', lines: 60 }), answer) : undefined;
        if (!option || !s.turn) {
          const text = withNotes(ctx, answer);
          return send(ctx, s, p, text, lastLineOf(text));
        }
        const turn: TurnAnchor = { ...s.turn, seq: agent.stateChangeSeq, blockedAtSend: true };
        ctx.saveState({ ...s, turn, parkedSeq: undefined, lapsesAt: undefined });
        await herdr.sendText(s.paneId, option);
        ctx.progress(`picked option ${option} of the dialog`);
        return watch(ctx, s, p, turn);
      });
    },

    // An unreachable herdr rejects (issue #368): the machine may not have dialled in yet.
    async canReattach(job) {
      return (await liveTurn(job)) !== undefined;
    },

    reattach(ctx) {
      const saved = paneStateOf(ctx.job);
      const p = resolvePayload(ctx.job, ctx.machine);
      // A job started before an install that reported work trees has none on it yet: the one its pane opened in.
      const tree = saved ? { cwd: saved.jobWorktree ?? saved.cwd } : workTreeOn(ctx.machine, p.cwd);
      if ('cwd' in tree) ctx.workTree(tree.cwd);
      return onLane(ctx, () => saved && heldOf(saved, ctx.job.id), async () => {
        const state = await liveTurn(ctx.job);
        if (!state) return { kind: 'failed', error: 'interrupted by daemon restart' };
        lanes.set(ctx.laneId, heldOf(state, ctx.job.id));
        // A dialog before the send, answered in the pane (issue #534): the text goes now.
        if (state.turn.unsent) return send(ctx, state, p, state.turn.text ?? '', state.turn.anchor);
        if (state.login) {
          // It waited on a login (issue #476): it waits on, its URL and code read back from the screen.
          restoreLogin(ctx, await herdrOn(state).read(state.paneId, { source: 'recent-unwrapped', lines: RECENT_LINES }), state.turn.anchor, state.login, clock.now());
          return watch(ctx, state, p, state.turn, { count: 0, startedAt: clock.now().getTime(), quiet: true });
        }
        return watch(ctx, state, p, state.turn);
      });
    },

    async answeredInPane(job) {
      const s = paneStateOf(job);
      return s?.turn ? readPaneAnswer(herdrOn(s), { ...s, turn: s.turn }, clock).catch(() => null) : null;
    },

    // A job waiting on its own background command (issue #1037).
    ...ownCommandProbes(herdrOn), ...paneLostProbe(herdrOn), ...terminalProbes(herdrOn),

    // Claude exits as at a close, its scope and processes stop, its pane closes; its worktree and session stay.
    async park(job) {
      const state = paneStateOf(job);
      const open = state ? await exitAndClose(heldOf(state, job.id), 'none') : undefined;
      if (open) throw new Error(`pane ${state!.paneId} may still be open: ${open}`);
    },

    // The pane a job left on a machine it moved off (issue #1569).
    ...paneLeft(herdrOn, exitAndClose),

    // Read on the job's machine through its own connection, never the pane (issue #921): its worktree and agent session.
    checkpoint: (job) => checkpointOn(job, herdrOn),

    async cleanup(job, o) {
      const state = paneStateOf(job);
      // Parked (issue #501), or released on its wait (issue #2303): its pane closed then, and its id may name another job's pane by now. Only the reap runs.
      // Timed out (issue #630), or a retention set for its status (issue #2494): its scratch dir stays, as a parked job's,
      // until it goes on or the sweep removes it.
      const scratch = job.liveness || o?.keepScratch ? 'keep' : 'remove'; if (state && (job.parked || job.waitReleased)) return reap(herdrOn(state), heldOf(state, job.id), scratch);
      const open = state ? await exitAndClose(heldOf(state, job.id), scratch) : undefined;
      if (open) throw new Error(`pane ${state!.paneId} may still be open: ${open}`);
      const said = reaped.get(job.id);
      reaped.delete(job.id);
      outputAt.delete(job.id); codes.delete(job.id);
      return said;
    },

    machineShell: (machine) => herdrAt(machine),
    // The machine's terminal (issue #1128): the hopper's herdr session there, every pane of it.
    paneSession(machine) {
      const herdr = herdrAt(machine);
      return herdr ? paneSessionOn(herdr) : undefined;
    },
  };
}
