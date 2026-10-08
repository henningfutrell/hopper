// The herdr-claude executor: one Claude Code job per herdr tab, driven through the screen
// protocol. docs/design.md "Phase 2" → "herdr-claude executor".

import type { Clock, ExecutionContext, ExecutionOutcome, Executor, Reaped } from '../../domain/ports.ts';
import type { Job, LaneId } from '../../domain/types.ts';
import type { HerdrClient } from './client.ts';
import { RECENT_LINES, abortReason, tail, watchTurn } from './monitor.ts';
import type { Interrupt, Sleep } from './monitor.ts';
import { resolvePayload, validatePayload, workTreeOn } from './payload.ts';
import type { ClaudeJobPayload } from './payload.ts';
import { FOOTER_ANCHOR, STATUS_NOTE_NUDGE, dialogOption, inputBoxText, protocolFooter, typedAfterQuestion } from './screen.ts';
import { jobScratchOf, openPane, startClaude } from './start.ts';
import type { PaneState, StartDeps, TurnAnchor } from './start.ts';

const UNBLOCK_POLLS = 10;
/** Sends of one text that never reach Claude (lost sends, issue #278) before the job fails. */
const MAX_SENDS = 3;
/** How long Claude has to exit by itself before the reap stops it with the job's other processes. */
const EXIT_WAIT_MS = 5000;
/**
 * How early a dialog may count as lapsed (issue #376): its countdown is read when the job parks, in whole
 * seconds and up to a poll after the dialog showed, so Claude Code's own deadline can come a little sooner.
 */
const LAPSE_SLACK_MS = 5000;

export interface HerdrClaudeExecutorOptions {
  /** This machine's herdr. */
  herdr: HerdrClient;
  /** The herdr of an attached machine. Absent → jobs on one fail. */
  remote?: (there: RemoteHerdr) => HerdrClient;
  /** Another herdr session on this machine: the one this machine was added with (issue #260). Absent → `herdr`'s. */
  local?: (session: string) => HerdrClient;
  clock: Clock;
  defaultCwd: string;
  /** Claude's arguments as it starts: `claudeArgsFor(yolo, args)`. */
  claudeArgs: string[];
  trustWorkdir: boolean;
  /** Claude starts with every permission granted (issue #267): its warning is accepted at startup. Default false. */
  yolo?: boolean;
  /** Each job its own git worktree of a work tree that is a git repository's top, in its scratch dir (issue #379). Default false. */
  jobWorktrees?: boolean;
  /** A job worktree's node_modules linked to dependencies shared with the repository's other jobs (issue #410). Default false. */
  sharedDependencies?: boolean;
  pollMs: number;
  /** Idle without a marker this long, a turn is a status note and the agent is nudged; each further one in a row waits twice as long. */
  idleNudgeMs: number;
  /** Set on the tab of a job in this machine's herdr: the user's CLI config dirs (issue #158). Default none. */
  paneEnv?: Readonly<Record<string, string>>;
  /** Injectable for tests; default an abortable setTimeout. */
  sleep?: Sleep;
}

export interface HerdrClaudeExecutor extends Executor {
  /** laneId → paneId for the job now running on that lane. */
  lanePanes(): ReadonlyMap<LaneId, string>;
}

const realSleep: Sleep = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});

const lastLineOf = (text: string): string => text.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? text.trim();

const heldOf = (s: PaneState, jobId: string): HeldPane => ({
  paneId: s.paneId, jobId, agentName: s.agentName, cwd: s.cwd, ...(s.ssh ? { ssh: s.ssh } : {}), ...(s.session ? { session: s.session } : {}),
  ...(s.client ? { client: { machine: s.client.machine } } : {}),
});

function paneStateOf(job: Job): PaneState | undefined {
  const s = job.executorState as Partial<PaneState> | undefined;
  return s?.paneId && s.agentName ? (s as PaneState) : undefined;
}

/** A client target (design.md "Client targets"): which machine. Its link and token are the runtime's (issue #308). */
export interface ClientTarget { machine: string }

/** An attached machine's herdr: an ssh target's (where, which session; herdr by name there, issue #311), or a client target's. */
export type RemoteHerdr = { ssh: string; session: string } | { client: ClientTarget };

/** Which herdr: a client target's, an ssh target's session, or (neither) this machine's, in `session` when given. */
interface Where { ssh?: string; session?: string; client?: ClientTarget }

/** A pane on one machine: pane ids are per herdr server, so two machines can share one. */
interface PaneOn extends Where { paneId: string }

/** A pane a lane holds, with the job it runs, for the reap. */
interface HeldPane extends PaneOn { jobId: string; agentName: string; cwd: string }


const samePane = (a: PaneOn, b: PaneOn): boolean => a.paneId === b.paneId && a.ssh === b.ssh && a.client?.machine === b.client?.machine
  && (a.ssh !== undefined || a.client !== undefined || a.session === b.session);

export function createHerdrClaudeExecutor(o: HerdrClaudeExecutorOptions): HerdrClaudeExecutor {
  const { clock } = o;
  const sleep = o.sleep ?? realSleep;
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
    herdr: herdrOn(where), clock, sleep, pollMs: o.pollMs, claudeArgs: o.claudeArgs, trustWorkdir: o.trustWorkdir, yolo: o.yolo ?? false,
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
   * is still up, and removes its scratch dir unless it holds work not pushed. Undefined when the machine
   * could not be reached: the sweep reaps it later.
   */
  async function reap(herdr: HerdrClient, pane: HeldPane): Promise<Reaped | undefined> {
    for (let waited = 0; waited < EXIT_WAIT_MS && await herdr.getAgent(pane.agentName).catch(() => null) !== null; waited += o.pollMs) {
      await sleep(o.pollMs, new AbortController().signal);
    }
    return herdr.reap(pane.jobId, jobScratchOf(pane.cwd, pane.jobId));
  }

  /** esc, ctrl+c twice, the reap, close. Swallows every error: the pane may already be gone. */
  async function exitAndClose(pane: HeldPane): Promise<void> {
    const close = async (herdr: HerdrClient): Promise<void> => {
      await herdr.sendKeys(pane.paneId, ['esc']).catch(() => {});
      await herdr.sendKeys(pane.paneId, ['ctrl+c', 'ctrl+c']).catch(() => {});
      const said = await reap(herdr, pane).catch(() => undefined);
      if (said) reaped.set(pane.jobId, said);
      await herdr.closePane(pane.paneId).catch(() => {});
    };
    await Promise.resolve().then(() => close(herdrOn(pane))).catch(() => {});
    for (const [lane, held] of lanes) if (samePane(held, pane)) lanes.delete(lane);
  }

  async function settle(result: ExecutionOutcome | Interrupt, pane: HeldPane): Promise<ExecutionOutcome> {
    if (!('interrupt' in result)) return result;
    if (result.interrupt === 'shutdown') return { kind: 'failed', error: 'shutdown' };
    await exitAndClose(pane);
    return { kind: 'failed', error: result.interrupt === 'timeout' ? 'timed out' : 'aborted' };
  }

  /** Status notes so far in a row, and when the turn they belong to began; lost sends of the text in flight. */
  interface Notes { count: number; startedAt: number; lost?: number }

  async function send(ctx: ExecutionContext, s: PaneState, p: ClaudeJobPayload, text: string, anchor: string, notes?: Notes): Promise<ExecutionOutcome | Interrupt> {
    const herdr = herdrOn(s);
    let agent = await herdr.getAgent(s.agentName);
    for (let i = 0; agent?.status === 'blocked' && i < UNBLOCK_POLLS; i++) {
      if (i === 0) await herdr.sendKeys(s.paneId, ['esc']);
      await sleep(o.pollMs, ctx.signal);
      if (ctx.signal.aborted) return { interrupt: abortReason(ctx.signal) };
      agent = await herdr.getAgent(s.agentName);
    }
    if (!agent) return { kind: 'failed', error: 'pane lost' };
    const turn: TurnAnchor = { seq: agent.stateChangeSeq, anchor, blockedAtSend: agent.status === 'blocked', text };
    // Saved before the prompt: a restart in between watches a turn never sent, which ends as a
    // lost send and is sent again, never as a lost job.
    ctx.saveState({ ...s, turn, parkedSeq: undefined, lapsesAt: undefined });
    await herdr.prompt(s.agentName, text);
    return watch(ctx, s, p, turn, notes);
  }

  /**
   * Watches the turn to its outcome. A status note (issue #163) opens no question: the agent is
   * nudged and the same turn goes on, under the same timeout. A lost send (issue #278) is submitted
   * with Enter when it sits in the input box, else sent again, at most MAX_SENDS times in all; then the
   * job fails, so it never stays running on a waiting Claude.
   */
  async function watch(ctx: ExecutionContext, s: PaneState, p: ClaudeJobPayload, turn: TurnAnchor, notes: Notes = { count: 0, startedAt: clock.now().getTime() }): Promise<ExecutionOutcome | Interrupt> {
    const result = await watchTurn({
      herdr: herdrOn(s), clock, sleep, pollMs: o.pollMs, idleNudgeMs: o.idleNudgeMs * 2 ** notes.count, ctx, agentName: s.agentName,
      paneId: s.paneId, anchor: turn.anchor, seqAtSend: turn.seq, blockedAtSend: turn.blockedAtSend,
      timeoutMs: p.timeoutMs, expectedMs: p.expectedMs, startedAt: notes.startedAt,
      parked: (seq, lapsesAt) => ctx.saveState({ ...s, turn, parkedSeq: seq, lapsesAt }),
    });
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
    return send(ctx, s, p, STATUS_NOTE_NUDGE, STATUS_NOTE_NUDGE, { count: notes.count + 1, startedAt: notes.startedAt });
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
      if (pane && !(ctx.signal.aborted && abortReason(ctx.signal) === 'shutdown')) await exitAndClose(pane);
      return { kind: 'failed', error: `herdr: ${(err as Error).message}` };
    } finally {
      const held = lanes.get(ctx.laneId);
      const pane = getPane();
      if (held && pane && samePane(held, pane)) lanes.delete(ctx.laneId);
    }
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
      const asked = resolvePayload(ctx.job.spec.payload, ctx.machine, o.defaultCwd);
      // Issue #323: `~` is the lane's machine's home, never this process's when the job runs elsewhere.
      const tree = workTreeOn(ctx.machine, asked.cwd);
      if ('error' in tree) return { kind: 'failed', error: tree.error };
      const p = { ...asked, cwd: tree.cwd, makeWorkTree: tree.make };
      ctx.workTree(p.cwd);
      let state: PaneState | undefined;
      return onLane(ctx, () => state && heldOf(state, ctx.job.id), async () => {
        const where = whereOn(ctx.machine);
        const deps = depsOn(where);
        const local = !where.ssh && !where.client;
        // The job acts through its source's connection (issue #214): its token in the pane's environment, never in the payload.
        const env = { ...p.env, ...ctx.credentials };
        const opened = await openPane(deps, ctx, p.cwd, local ? { ...env, ...o.paneEnv } : env);
        const refused = heldElsewhere(ctx.laneId, opened);
        if (refused) return refused;
        state = opened;
        lanes.set(ctx.laneId, heldOf(state, ctx.job.id));
        if (ctx.signal.aborted) return { interrupt: abortReason(ctx.signal) };
        const failed = await startClaude(deps, ctx, state, p);
        if (failed) {
          await exitAndClose(heldOf(state, ctx.job.id));
          return failed;
        }
        if (ctx.signal.aborted) return { interrupt: abortReason(ctx.signal) };
        return send(ctx, state, p, `${p.prompt}\n\n${protocolFooter(p.cwd, ctx.jobRules, jobScratchOf(p.cwd, ctx.job.id), state.jobWorktree, state.sharedDependencies === true)}`, FOOTER_ANCHOR);
      });
    },

    resume(ctx, answer) {
      const state = paneStateOf(ctx.job);
      if (!state) return Promise.resolve({ kind: 'failed', error: 'pane lost' });
      const p = resolvePayload(ctx.job.spec.payload, ctx.machine, o.defaultCwd);
      const refused = heldElsewhere(ctx.laneId, state);
      if (refused) return Promise.resolve(refused);
      return onLane(ctx, () => state && heldOf(state, ctx.job.id), async () => {
        const herdr = herdrOn(state);
        const agent = await herdr.getAgent(state.agentName);
        if (!agent) return { kind: 'failed', error: 'pane lost' };
        lanes.set(ctx.laneId, heldOf(state, ctx.job.id));
        const s = { ...state, laneId: ctx.laneId };
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

    async canReattach(job) {
      return (await liveTurn(job).catch(() => undefined)) !== undefined;
    },

    reattach(ctx) {
      const saved = paneStateOf(ctx.job);
      const p = resolvePayload(ctx.job.spec.payload, ctx.machine, o.defaultCwd);
      // A job started before an install that reported work trees has none on it yet: the one its pane opened in.
      const tree = saved ? { cwd: saved.jobWorktree ?? saved.cwd } : workTreeOn(ctx.machine, p.cwd);
      if ('cwd' in tree) ctx.workTree(tree.cwd);
      return onLane(ctx, () => saved && heldOf(saved, ctx.job.id), async () => {
        const state = await liveTurn(ctx.job);
        if (!state) return { kind: 'failed', error: 'interrupted by daemon restart' };
        lanes.set(ctx.laneId, heldOf(state, ctx.job.id));
        return watch(ctx, state, p, state.turn);
      });
    },

    async answeredInPane(job) {
      try {
        const s = paneStateOf(job);
        if (!s?.turn) return null;
        const herdr = herdrOn(s);
        const agent = await herdr.getAgent(s.agentName);
        if (!agent || agent.paneId !== s.paneId) return null;
        // Parked before parkedSeq was saved: the send's seq (the turn had already ended past it).
        const parked = s.parkedSeq ?? s.turn.seq;
        if (agent.stateChangeSeq <= parked) return null;
        const recent = await herdr.read(s.paneId, { source: 'recent-unwrapped', lines: RECENT_LINES });
        const typed = typedAfterQuestion(recent, s.turn.anchor);
        // A seq move alone may be herdr's own idle/done flip; working, or a typed echo, is the owner.
        if (agent.status !== 'working' && typed === undefined) return null;
        const turn: TurnAnchor = { seq: parked, anchor: typed ? lastLineOf(typed) : s.turn.anchor, blockedAtSend: false };
        const { parkedSeq: _drop, lapsesAt, ...rest } = s;
        // Nothing typed, and the dialog's countdown has run out: Claude Code denied it by itself, nobody answered (issue #376).
        const lapsed = typed === undefined && lapsesAt !== undefined && clock.now().getTime() >= Date.parse(lapsesAt) - LAPSE_SLACK_MS;
        if (lapsed) return { lapsed: true, executorState: { ...rest, turn } };
        return { ...(typed ? { answer: typed } : {}), executorState: { ...rest, turn } };
      } catch {
        return null;
      }
    },

    async cleanup(job) {
      const state = paneStateOf(job);
      if (state) await exitAndClose(heldOf(state, job.id));
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
