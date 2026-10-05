// The herdr-claude executor: one Claude Code job per herdr tab, driven through the screen
// protocol. docs/design.md "Phase 2" → "herdr-claude executor".

import type { Clock, ExecutionContext, ExecutionOutcome, Executor } from '../../domain/ports.ts';
import type { Job, LaneId } from '../../domain/types.ts';
import type { HerdrClient } from './client.ts';
import { RECENT_LINES, abortReason, watchTurn } from './monitor.ts';
import type { Interrupt, Sleep } from './monitor.ts';
import { resolvePayload, validatePayload } from './payload.ts';
import type { ClaudeJobPayload } from './payload.ts';
import { FOOTER_ANCHOR, STATUS_NOTE_NUDGE, protocolFooter, typedAfterQuestion } from './screen.ts';
import { openPane, startClaude } from './start.ts';
import type { PaneState, StartDeps, TurnAnchor } from './start.ts';

const UNBLOCK_POLLS = 10;

export interface HerdrClaudeExecutorOptions {
  /** This machine's herdr. */
  herdr: HerdrClient;
  /** The herdr of an attached machine. Absent → jobs on one fail. */
  remote?: (there: RemoteHerdr) => HerdrClient;
  clock: Clock;
  defaultCwd: string;
  claudeArgs: string[];
  trustWorkdir: boolean;
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

const heldOf = (s: PaneState): HeldPane => ({
  paneId: s.paneId, ...(s.ssh ? { ssh: s.ssh, ...(s.herdrBin ? { herdrBin: s.herdrBin } : {}), ...(s.session ? { session: s.session } : {}) } : {}),
  ...(s.client ? { client: s.client } : {}),
});

function paneStateOf(job: Job): PaneState | undefined {
  const s = job.executorState as Partial<PaneState> | undefined;
  return s?.paneId && s.agentName ? (s as PaneState) : undefined;
}

/** A client target (design.md "Client targets"): which machine, and the variable its token is in. */
export interface ClientTarget { machine: string; tokenEnv: string }

/** An attached machine's herdr: an ssh target's (where, which binary, which session), or a client target's. */
export type RemoteHerdr = { ssh: string; bin: string; session: string } | { client: ClientTarget };

/** Which herdr: a client target's, an ssh target's binary and session, or (neither) this machine's. */
interface Where { ssh?: string; herdrBin?: string; session?: string; client?: ClientTarget }

/** A pane on one machine: pane ids are per herdr server, so two machines can share one. */
interface HeldPane extends Where { paneId: string }

const samePane = (a: HeldPane, b: HeldPane): boolean => a.paneId === b.paneId && a.ssh === b.ssh && a.client?.machine === b.client?.machine;

export function createHerdrClaudeExecutor(o: HerdrClaudeExecutorOptions): HerdrClaudeExecutor {
  const { clock } = o;
  const sleep = o.sleep ?? realSleep;
  const lanes = new Map<LaneId, HeldPane>();

  /** The herdr a pane lives on: this machine's, or the attached machine's over ssh. */
  function herdrOn(p: Where): HerdrClient {
    if (p.client) {
      if (!o.remote) throw new Error(`cannot reach client target ${p.client.machine}`);
      return o.remote({ client: p.client });
    }
    if (!p.ssh) return o.herdr;
    if (!o.remote || !p.herdrBin || !p.session) throw new Error(`cannot reach attached machine ${p.ssh}: no herdr there`);
    return o.remote({ ssh: p.ssh, bin: p.herdrBin, session: p.session });
  }

  /** Where a job on the lane's machine runs. */
  const whereOn = (m: ExecutionContext['machine']): Where => {
    if (m.client) return { client: { machine: m.id, tokenEnv: m.client.tokenEnv } };
    return m.ssh ? { ssh: m.ssh, ...(m.herdr ? { herdrBin: m.herdr.bin, session: m.herdr.session } : {}) } : {};
  };

  const depsOn = (where: Where): StartDeps => ({
    herdr: herdrOn(where), clock, sleep, pollMs: o.pollMs, claudeArgs: o.claudeArgs, trustWorkdir: o.trustWorkdir,
  });

  /** The refusal when the pane is already mapped to another lane; a lane never shares a pane. */
  function heldElsewhere(laneId: LaneId, pane: HeldPane): ExecutionOutcome | null {
    for (const [lane, held] of lanes) {
      if (samePane(held, pane) && lane !== laneId) return { kind: 'failed', error: `herdr: pane ${pane.paneId} is already held by lane ${lane}` };
    }
    return null;
  }

  /** esc, ctrl+c twice, close. Swallows every error: the pane may already be gone. */
  async function exitAndClose(pane: HeldPane): Promise<void> {
    const close = async (herdr: HerdrClient): Promise<void> => {
      await herdr.sendKeys(pane.paneId, ['esc']).catch(() => {});
      await herdr.sendKeys(pane.paneId, ['ctrl+c', 'ctrl+c']).catch(() => {});
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

  /** Status notes so far in a row, and when the turn they belong to began. */
  interface Notes { count: number; startedAt: number }

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
    const turn: TurnAnchor = { seq: agent.stateChangeSeq, anchor, blockedAtSend: agent.status === 'blocked' };
    // Saved before the prompt: a restart in between watches a turn never sent, which ends as a
    // status note and a nudge, never as a lost job.
    ctx.saveState({ ...s, turn, parkedSeq: undefined });
    await herdr.prompt(s.agentName, text);
    return watch(ctx, s, p, turn, notes);
  }

  /**
   * Watches the turn to its outcome. A status note (issue #163) opens no question: the agent is
   * nudged and the same turn goes on, under the same timeout.
   */
  async function watch(ctx: ExecutionContext, s: PaneState, p: ClaudeJobPayload, turn: TurnAnchor, notes: Notes = { count: 0, startedAt: clock.now().getTime() }): Promise<ExecutionOutcome | Interrupt> {
    const result = await watchTurn({
      herdr: herdrOn(s), clock, sleep, pollMs: o.pollMs, idleNudgeMs: o.idleNudgeMs * 2 ** notes.count, ctx, agentName: s.agentName,
      paneId: s.paneId, anchor: turn.anchor, seqAtSend: turn.seq, blockedAtSend: turn.blockedAtSend,
      timeoutMs: p.timeoutMs, expectedMs: p.expectedMs, startedAt: notes.startedAt,
      parked: (seq) => ctx.saveState({ ...s, turn, parkedSeq: seq }),
    });
    if (!('statusNote' in result)) return result;
    return send(ctx, s, p, STATUS_NOTE_NUDGE, STATUS_NOTE_NUDGE, { ...notes, count: notes.count + 1 });
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
      const p = resolvePayload(ctx.job.spec.payload, o.defaultCwd);
      ctx.workTree(p.cwd);
      let state: PaneState | undefined;
      return onLane(ctx, () => state, async () => {
        const where = whereOn(ctx.machine);
        const deps = depsOn(where);
        const local = !where.ssh && !where.client;
        const opened = await openPane(deps, ctx, p.cwd, local ? { ...p.env, ...o.paneEnv } : p.env);
        const refused = heldElsewhere(ctx.laneId, opened);
        if (refused) return refused;
        state = opened;
        lanes.set(ctx.laneId, heldOf(state));
        if (ctx.signal.aborted) return { interrupt: abortReason(ctx.signal) };
        const failed = await startClaude(deps, ctx, state, p);
        if (failed) {
          await exitAndClose(state);
          return failed;
        }
        if (ctx.signal.aborted) return { interrupt: abortReason(ctx.signal) };
        return send(ctx, state, p, `${p.prompt}\n\n${protocolFooter(p.cwd)}`, FOOTER_ANCHOR);
      });
    },

    resume(ctx, answer) {
      const state = paneStateOf(ctx.job);
      if (!state) return Promise.resolve({ kind: 'failed', error: 'pane lost' });
      const p = resolvePayload(ctx.job.spec.payload, o.defaultCwd);
      const refused = heldElsewhere(ctx.laneId, state);
      if (refused) return Promise.resolve(refused);
      return onLane(ctx, () => state, async () => {
        if (!(await herdrOn(state).getAgent(state.agentName))) return { kind: 'failed', error: 'pane lost' };
        lanes.set(ctx.laneId, heldOf(state));
        return send(ctx, { ...state, laneId: ctx.laneId }, p, answer, lastLineOf(answer));
      });
    },

    async canReattach(job) {
      return (await liveTurn(job).catch(() => undefined)) !== undefined;
    },

    reattach(ctx) {
      const saved = paneStateOf(ctx.job);
      const p = resolvePayload(ctx.job.spec.payload, o.defaultCwd);
      return onLane(ctx, () => saved, async () => {
        const state = await liveTurn(ctx.job);
        if (!state) return { kind: 'failed', error: 'interrupted by daemon restart' };
        lanes.set(ctx.laneId, heldOf(state));
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
        const { parkedSeq: _drop, ...rest } = s;
        return { ...(typed ? { answer: typed } : {}), executorState: { ...rest, turn } };
      } catch {
        return null;
      }
    },

    async cleanup(job) {
      const state = paneStateOf(job);
      if (state) await exitAndClose(state);
    },
  };
}
