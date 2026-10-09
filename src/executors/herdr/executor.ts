// The herdr-claude executor: one Claude Code job per herdr tab, driven through the screen
// protocol. docs/design.md "Phase 2" → "herdr-claude executor".

import type { Clock, ExecutionContext, ExecutionOutcome, Executor, Reaped } from '../../domain/ports.ts';
import type { Job, LaneId } from '../../domain/types.ts';
import { HerdrError, type HerdrClient } from './client.ts';
import { RECENT_LINES, abortReason, tail, watchTurn } from './monitor.ts';
import { afterStatusNote, nudgeGapMs } from './nudge.ts';
import type { Interrupt, Sleep } from './monitor.ts';
import { afterLoginAct, loginWait, restoreLogin, takeLogin, type LoginRef } from './login.ts';
import { resolvePayload, validatePayload, workTreeOn } from './payload.ts';
import type { ClaudeJobPayload } from './payload.ts';
import { FOOTER_ANCHOR, STATUS_NOTE_NUDGE, dialogOption, inputBoxText, protocolFooter } from './screen.ts';
import { readPaneAnswer } from './pane-answer.ts';
import { answerDialog, readyFor } from './before-send.ts';
import { jobScratchOf, startInPane } from './start.ts';
import type { PaneState, StartDeps, TurnAnchor } from './start.ts';
import { heldOf, lastLineOf, paneStateOf, realSleep, samePane, type HeldPane, type PaneOn, type RemoteHerdr, type Where } from './panes.ts';

export type { ClientTarget, RemoteHerdr } from './panes.ts';

/** Sends of one text that never reach Claude (lost sends, issue #278) before the job fails. */
const MAX_SENDS = 3;
/** How long Claude has to exit by itself before the reap stops it with the job's other processes. */
const EXIT_WAIT_MS = 5000;

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

  /** Where a job on the lane's machine runs. */
  const whereOn = (m: ExecutionContext['machine']): Where => {
    if (m.client) return { client: { machine: m.id } };
    if (m.ssh) return { ssh: m.ssh, ...(m.herdr ? { session: m.herdr.session } : {}) };
    return m.herdr ? { session: m.herdr.session } : {};
  };

  const depsOn = (where: Where): StartDeps => ({
    herdr: herdrOn(where), clock, sleep, pollMs: o.pollMs, claudeArgs: o.claudeArgs, trustWorkdir: o.trustWorkdir, yolo: o.yolo ?? false, unattended: o.unattended ?? false,
    jobWorktrees: o.jobWorktrees ?? false, sharedDependencies: o.sharedDependencies ?? false,
  });

  /** The refusal when the pane is already mapped to another lane; a lane never shares a pane. */
  function heldElsewhere(laneId: LaneId, pane: PaneOn): ExecutionOutcome | null {
    for (const [lane, held] of lanes) {
      if (samePane(held, pane) && lane !== laneId) return { kind: 'failed', error: `herdr: pane ${pane.paneId} is already held by lane ${lane}` };
    }
    return null;
  }

  /**
   * The reap (issues #401, #410): Claude gets a moment to exit by itself, then the job's machine — through
   * its own connection, never the pane — stops the job's scope and its processes, Claude among them if it
   * is still up, and removes its scratch dir unless it holds work not pushed — or keeps it (`scratch` false: a
   * parked job's, issue #501). Undefined when the machine could not be reached: the sweep reaps it later.
   */
  async function reap(herdr: HerdrClient, pane: HeldPane, scratch = true): Promise<Reaped | undefined> {
    for (let waited = 0; waited < EXIT_WAIT_MS && await herdr.getAgent(pane.agentName).catch(() => null) !== null; waited += o.pollMs) {
      await sleep(o.pollMs, new AbortController().signal);
    }
    return herdr.reap(pane.jobId, scratch ? jobScratchOf(pane.cwd, pane.jobId) : undefined);
  }

  /**
   * esc, ctrl+c twice, the reap, close. Never rejects: the pane may already be gone. Answers why the
   * pane may still be open — its herdr not reached, or the close refused — or undefined once it is
   * closed or gone (issue #371). `scratch` false: the scratch dir stays (a parked job's, issue #501).
   */
  async function exitAndClose(pane: HeldPane, scratch = true): Promise<string | undefined> {
    const close = async (herdr: HerdrClient): Promise<string | undefined> => {
      await herdr.sendKeys(pane.paneId, ['esc']).catch(() => {});
      await herdr.sendKeys(pane.paneId, ['ctrl+c', 'ctrl+c']).catch(() => {});
      const said = await reap(herdr, pane, scratch).catch(() => undefined);
      if (said && scratch) reaped.set(pane.jobId, said);
      return herdr.closePane(pane.paneId).then(() => undefined, (e: unknown) => (e instanceof HerdrError && e.code === 'pane_not_found' ? undefined : `herdr: ${(e as Error).message}`));
    };
    const open = await Promise.resolve().then(() => close(herdrOn(pane))).catch((e: unknown) => `herdr: ${(e as Error).message}`);
    for (const [lane, held] of lanes) if (samePane(held, pane)) lanes.delete(lane);
    return open;
  }

  async function settle(result: ExecutionOutcome | Interrupt, pane: HeldPane): Promise<ExecutionOutcome> {
    if (!('interrupt' in result)) return result;
    if (result.interrupt === 'shutdown') return { kind: 'failed', error: 'shutdown' };
    // The engine parks the job, then asks `park` to end its pane: nothing of it is closed here.
    if (result.interrupt === 'park') return { kind: 'failed', error: 'parked' };
    await exitAndClose(pane);
    return { kind: 'failed', error: result.interrupt === 'timeout' ? 'timed out' : 'aborted' };
  }

  /**
   * Nudges so far in a row, and when the turn they belong to began; lost sends of the text in flight; `quiet`
   * once the nudges stopped (issue #491), until Claude works again by itself.
   */
  interface Notes { count: number; startedAt: number; lost?: number; quiet?: boolean; unreadable?: number }

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
      if (err === undefined) return watch(ctx, s, p, turn, notes);
      if (refused || !(err instanceof HerdrError) || err.code !== 'agent_blocked') throw err;
    }
  }

  /**
   * Watches the turn to its outcome. A status note (issue #163) opens no question: the agent is
   * nudged and the same turn goes on, under the same timeout. A lost send (issue #278) is submitted
   * with Enter when it sits in the input box, else sent again, at most MAX_SENDS times in all; then the
   * job fails, so it never stays running on a waiting Claude.
   */
  async function watch(ctx: ExecutionContext, s: PaneState, p: ClaudeJobPayload, turn: TurnAnchor, notes: Notes = { count: 0, startedAt: clock.now().getTime() }, login?: LoginRef): Promise<ExecutionOutcome | Interrupt> {
    const result = await watchTurn({
      herdr: herdrOn(s), clock, sleep, pollMs: o.pollMs, idleNudgeMs: nudgeGapMs(notes.count, o.idleNudgeMs), stallMs: o.idleNudgeMs, untilWorking: notes.quiet, ctx, agentName: s.agentName,
      paneId: s.paneId, anchor: turn.anchor, seqAtSend: turn.seq, blockedAtSend: turn.blockedAtSend,
      timeoutMs: p.timeoutMs, expectedMs: p.expectedMs, startedAt: notes.startedAt,
      onQuestion: (seq, lapsesAt) => ctx.saveState({ ...s, turn, parkedSeq: seq, lapsesAt }),
      ...(login ? { login: loginWait(ctx, login, () => ctx.saveState({ ...s, login: undefined })) } : {}),
    });
    if ('authPending' in result) {
      // A login (issue #476): to the logins, never a question; the job waits, no nudge, for Claude to go on by itself.
      const unreadable = (notes.unreadable ?? 0) + 1;
      const taken = takeLogin(ctx, result.authPending, clock.now(), unreadable);
      if ('failed' in taken) return { kind: 'failed', error: taken.failed };
      if ('say' in taken) return send(ctx, s, p, taken.say, lastLineOf(taken.say), { count: notes.count, startedAt: notes.startedAt, unreadable });
      const waiting = { ...s, turn, login: taken.login, parkedSeq: undefined, lapsesAt: undefined };
      ctx.saveState(waiting);
      return watch(ctx, waiting, p, turn, { count: 0, startedAt: notes.startedAt, quiet: true }, taken.login);
    }
    if ('login' in result) {
      // The user acted on the login the job waits on (issue #476).
      const next = afterLoginAct(result.login, login?.tool ?? 'the');
      if ('failed' in next) return { kind: 'failed', error: next.failed };
      ctx.progress(0, next.progress);
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
        ctx.progress(0, 'the prompt never reached claude: sent it again');
        return send(ctx, s, p, turn.text!, turn.anchor, again);
      }
      // Pasted but never submitted (seen live): Enter submits it; sending it again would paste it twice.
      const agent = await herdr.getAgent(s.agentName);
      if (!agent) return { kind: 'failed', error: 'pane lost' };
      const next: TurnAnchor = { ...turn, seq: agent.stateChangeSeq };
      ctx.saveState({ ...s, turn: next, parkedSeq: undefined, lapsesAt: undefined });
      await herdr.sendKeys(s.paneId, ['enter']);
      ctx.progress(0, "the prompt sat unsent in claude's input: submitted it");
      return watch(ctx, s, p, next, again);
    }
    if (!('statusNote' in result)) return result;
    const next = afterStatusNote(notes);
    if ('spent' in next) { ctx.progress(0, next.spent); return watch(ctx, s, p, turn, { count: notes.count, startedAt: notes.startedAt, quiet: true }); }
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
  function startIn(ctx: ExecutionContext, p: ClaudeJobPayload, held: (s: PaneState | undefined) => void, resume?: string): Promise<PaneState | ExecutionOutcome | Interrupt> {
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
        const refused = heldElsewhere(ctx.laneId, s);
        if (refused) return refused;
        held(s);
        lanes.set(ctx.laneId, heldOf(s, ctx.job.id));
        return null;
      },
      close: async (s) => { await exitAndClose(heldOf(s, ctx.job.id)); held(undefined); },
      random, ...(resume ? { resume } : {}),
    });
  }

  /**
   * A parked job re-queued (issue #501): whatever of it still runs on its machine is stopped first — two agents in
   * one session would interleave —, then a new pane opens in its work tree, Claude resumes its recorded session
   * there (its worktree found where it was left), and the answer goes to it. With none recorded (issue #530), a fresh
   * session starts there instead, sent its task, `answer` (the engine's brief: its question and answer) and the footer.
   */
  function reopen(ctx: ExecutionContext, saved: PaneState | undefined, answer: string): Promise<ExecutionOutcome> {
    const session = ctx.job.agentSession;
    if (!saved) return Promise.resolve({ kind: 'failed', error: 'the parked job has no pane state: its work tree is not known' });
    const p = { ...resolvePayload(ctx.job, ctx.machine), cwd: saved.cwd, makeWorkTree: false };
    ctx.workTree(saved.jobWorktree ?? saved.cwd);
    let state: PaneState | undefined;
    return onLane(ctx, () => state && heldOf(state, ctx.job.id), async () => {
      await herdrOn(whereOn(ctx.machine)).reap(ctx.job.id);
      const started = await startIn(ctx, p, (s) => { state = s; }, session);
      if ('kind' in started || 'interrupt' in started) return started;
      ctx.progress(0, session ? `resumed agent session ${session}` : 'started a fresh agent session in the kept work tree: none was recorded');
      return session ? send(ctx, started, p, answer, lastLineOf(answer)) : send(ctx, started, p, `${p.prompt}\n\n${answer}\n\n${protocolFooter(p.cwd, ctx.jobRules, jobScratchOf(p.cwd, ctx.job.id), started.jobWorktree, started.sharedDependencies === true, started.checkout)}`, FOOTER_ANCHOR);
    });
  }

  return {
    name: 'herdr-claude',
    idempotent: false,
    lanePanes: () => new Map([...lanes].map(([lane, held]) => [lane, held.paneId])),
    validate: validatePayload,

    async run(ctx) {
      // A container target (issue #58) has no herdr; without this the job would run on this machine.
      if (ctx.machine.docker) return { kind: 'failed', error: `herdr-claude does not run on container target ${ctx.machine.id}: it has no herdr; give it the command executor` };
      // An ssh target that runs no herdr (issue #142): without this the job would run in this machine's herdr.
      if (ctx.machine.ssh && !ctx.machine.herdr) return { kind: 'failed', error: `herdr-claude does not run on ${ctx.machine.id}: it runs no herdr; give it another executor` };
      const asked = resolvePayload(ctx.job, ctx.machine);
      // Issue #323: `~` is the lane's machine's home, never this process's when the job runs elsewhere.
      const tree = workTreeOn(ctx.machine, asked.cwd);
      if ('error' in tree) return { kind: 'failed', error: tree.error };
      const p = { ...asked, cwd: tree.cwd };
      ctx.workTree(p.cwd);
      let state: PaneState | undefined;
      return onLane(ctx, () => state && heldOf(state, ctx.job.id), async () => {
        const started = await startIn(ctx, p, (s) => { state = s; });
        if ('kind' in started || 'interrupt' in started) return started;
        return send(ctx, started, p, `${p.prompt}\n\n${protocolFooter(p.cwd, ctx.jobRules, jobScratchOf(p.cwd, ctx.job.id), started.jobWorktree, started.sharedDependencies === true, started.checkout)}`, FOOTER_ANCHOR);
      });
    },

    resume(ctx, answer) {
      const state = paneStateOf(ctx.job);
      if (ctx.job.parked) return reopen(ctx, state, answer);
      if (!state) return Promise.resolve({ kind: 'failed', error: 'pane lost' });
      const p = resolvePayload(ctx.job, ctx.machine);
      const refused = heldElsewhere(ctx.laneId, state);
      if (refused) return Promise.resolve(refused);
      return onLane(ctx, () => state && heldOf(state, ctx.job.id), async () => {
        const herdr = herdrOn(state);
        const agent = await herdr.getAgent(state.agentName);
        if (!agent) return { kind: 'failed', error: 'pane lost' };
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
        if (!option || !s.turn) return send(ctx, s, p, answer, lastLineOf(answer));
        const turn: TurnAnchor = { ...s.turn, seq: agent.stateChangeSeq, blockedAtSend: true };
        ctx.saveState({ ...s, turn, parkedSeq: undefined, lapsesAt: undefined });
        await herdr.sendText(s.paneId, option);
        ctx.progress(0, `picked option ${option} of the dialog`);
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
          return watch(ctx, state, p, state.turn, { count: 0, startedAt: clock.now().getTime(), quiet: true }, state.login);
        }
        return watch(ctx, state, p, state.turn);
      });
    },

    async answeredInPane(job) {
      const s = paneStateOf(job);
      return s?.turn ? readPaneAnswer(herdrOn(s), { ...s, turn: s.turn }, clock).catch(() => null) : null;
    },

    // Claude exits as at a close, its scope and processes stop, its pane closes; its worktree and session stay.
    async park(job) {
      const state = paneStateOf(job);
      const open = state ? await exitAndClose(heldOf(state, job.id), false) : undefined;
      if (open) throw new Error(`pane ${state!.paneId} may still be open: ${open}`);
    },

    async cleanup(job) {
      const state = paneStateOf(job);
      // Parked (issue #501): its pane closed then, and its id may name another job's pane by now. Only the reap runs.
      if (state && job.parked) return reap(herdrOn(state), heldOf(state, job.id));
      const open = state ? await exitAndClose(heldOf(state, job.id)) : undefined;
      if (open) throw new Error(`pane ${state!.paneId} may still be open: ${open}`);
      const said = reaped.get(job.id);
      reaped.delete(job.id);
      return said;
    },

    machineShell(machine) {
      try {
        return herdrOn(whereOn(machine));
      } catch {
        return undefined;
      }
    },
  };
}
