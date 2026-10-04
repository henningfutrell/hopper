// The herdr-claude executor: one Claude Code job per herdr tab, driven through the screen
// protocol. docs/design.md "Phase 2" → "herdr-claude executor".

import type { Clock, ExecutionContext, ExecutionOutcome, Executor } from '../../domain/ports.ts';
import type { Job, LaneId } from '../../domain/types.ts';
import type { HerdrClient } from './client.ts';
import { abortReason, watchTurn } from './monitor.ts';
import type { Interrupt, Sleep } from './monitor.ts';
import { resolvePayload, validatePayload } from './payload.ts';
import type { ClaudeJobPayload } from './payload.ts';
import { FOOTER_ANCHOR, PROTOCOL_FOOTER } from './screen.ts';
import { openPane, startClaude } from './start.ts';
import type { PaneState, StartDeps, TurnAnchor } from './start.ts';

const UNBLOCK_POLLS = 10;

export interface HerdrClaudeExecutorOptions {
  herdr: HerdrClient;
  clock: Clock;
  defaultCwd: string;
  claudeArgs: string[];
  trustWorkdir: boolean;
  pollMs: number;
  idleQuestionMs: number;
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

function paneStateOf(job: Job): PaneState | undefined {
  const s = job.executorState as Partial<PaneState> | undefined;
  return s?.paneId && s.agentName ? (s as PaneState) : undefined;
}

export function createHerdrClaudeExecutor(o: HerdrClaudeExecutorOptions): HerdrClaudeExecutor {
  const { herdr, clock } = o;
  const sleep = o.sleep ?? realSleep;
  const deps: StartDeps = { herdr, clock, sleep, pollMs: o.pollMs, claudeArgs: o.claudeArgs, trustWorkdir: o.trustWorkdir };
  const lanes = new Map<LaneId, string>();

  /** esc, ctrl+c twice, close. Swallows every error: the pane may already be gone. */
  async function exitAndClose(paneId: string): Promise<void> {
    await herdr.sendKeys(paneId, ['esc']).catch(() => {});
    await herdr.sendKeys(paneId, ['ctrl+c', 'ctrl+c']).catch(() => {});
    await herdr.closePane(paneId).catch(() => {});
    for (const [lane, pane] of lanes) if (pane === paneId) lanes.delete(lane);
  }

  async function settle(result: ExecutionOutcome | Interrupt, paneId: string): Promise<ExecutionOutcome> {
    if (!('interrupt' in result)) return result;
    if (result.interrupt === 'shutdown') return { kind: 'failed', error: 'shutdown' };
    await exitAndClose(paneId);
    return { kind: 'failed', error: result.interrupt === 'timeout' ? 'timed out' : 'aborted' };
  }

  async function send(ctx: ExecutionContext, s: PaneState, p: ClaudeJobPayload, text: string, anchor: string): Promise<ExecutionOutcome | Interrupt> {
    let agent = await herdr.getAgent(s.agentName);
    for (let i = 0; agent?.status === 'blocked' && i < UNBLOCK_POLLS; i++) {
      if (i === 0) await herdr.sendKeys(s.paneId, ['esc']);
      await sleep(o.pollMs, ctx.signal);
      if (ctx.signal.aborted) return { interrupt: abortReason(ctx.signal) };
      agent = await herdr.getAgent(s.agentName);
    }
    if (!agent) return { kind: 'failed', error: 'pane lost' };
    const turn: TurnAnchor = { seq: agent.stateChangeSeq, anchor, blockedAtSend: agent.status === 'blocked' };
    // Saved before the prompt: a restart in between watches a turn never sent, which ends as an
    // idle question, never as a lost job.
    ctx.saveState({ ...s, turn });
    await herdr.prompt(s.agentName, text);
    return watch(ctx, s, p, turn);
  }

  function watch(ctx: ExecutionContext, s: PaneState, p: ClaudeJobPayload, turn: TurnAnchor): Promise<ExecutionOutcome | Interrupt> {
    return watchTurn({
      herdr, clock, sleep, pollMs: o.pollMs, idleQuestionMs: o.idleQuestionMs, ctx, agentName: s.agentName,
      paneId: s.paneId, anchor: turn.anchor, seqAtSend: turn.seq, blockedAtSend: turn.blockedAtSend,
      timeoutMs: p.timeoutMs, expectedMs: p.expectedMs,
    });
  }

  /** The saved pane, with its turn, when Claude still runs in that pane. */
  async function liveTurn(job: Job): Promise<(PaneState & { turn: TurnAnchor }) | undefined> {
    const state = paneStateOf(job);
    if (!state?.turn) return undefined;
    const agent = await herdr.getAgent(state.agentName);
    return agent?.paneId === state.paneId ? { ...state, turn: state.turn } : undefined;
  }

  /** Runs `body` with the lane mapped to the pane; never rejects; on error the pane is released. */
  async function onLane(ctx: ExecutionContext, getPane: () => string | undefined, body: () => Promise<ExecutionOutcome | Interrupt>): Promise<ExecutionOutcome> {
    try {
      const result = await body();
      const paneId = getPane();
      return paneId ? await settle(result, paneId) : ('interrupt' in result ? { kind: 'failed', error: 'aborted' } : result);
    } catch (err) {
      const paneId = getPane();
      if (paneId && !(ctx.signal.aborted && abortReason(ctx.signal) === 'shutdown')) await exitAndClose(paneId);
      return { kind: 'failed', error: `herdr: ${(err as Error).message}` };
    } finally {
      if (lanes.get(ctx.laneId) === getPane()) lanes.delete(ctx.laneId);
    }
  }

  return {
    name: 'herdr-claude',
    idempotent: false,
    lanePanes: () => lanes,
    validate: validatePayload,

    run(ctx) {
      const p = resolvePayload(ctx.job.spec.payload, o.defaultCwd);
      let state: PaneState | undefined;
      return onLane(ctx, () => state?.paneId, async () => {
        state = await openPane(deps, ctx, p.cwd, p.env);
        lanes.set(ctx.laneId, state.paneId);
        if (ctx.signal.aborted) return { interrupt: abortReason(ctx.signal) };
        const failed = await startClaude(deps, ctx, state, p);
        if (failed) {
          await exitAndClose(state.paneId);
          return failed;
        }
        if (ctx.signal.aborted) return { interrupt: abortReason(ctx.signal) };
        return send(ctx, state, p, `${p.prompt}\n\n${PROTOCOL_FOOTER}`, FOOTER_ANCHOR);
      });
    },

    resume(ctx, answer) {
      const state = paneStateOf(ctx.job);
      if (!state) return Promise.resolve({ kind: 'failed', error: 'pane lost' });
      const p = resolvePayload(ctx.job.spec.payload, o.defaultCwd);
      return onLane(ctx, () => state.paneId, async () => {
        if (!(await herdr.getAgent(state.agentName))) return { kind: 'failed', error: 'pane lost' };
        lanes.set(ctx.laneId, state.paneId);
        return send(ctx, { ...state, laneId: ctx.laneId }, p, answer, lastLineOf(answer));
      });
    },

    async canReattach(job) {
      return (await liveTurn(job).catch(() => undefined)) !== undefined;
    },

    reattach(ctx) {
      const saved = paneStateOf(ctx.job);
      const p = resolvePayload(ctx.job.spec.payload, o.defaultCwd);
      return onLane(ctx, () => saved?.paneId, async () => {
        const state = await liveTurn(ctx.job);
        if (!state) return { kind: 'failed', error: 'interrupted by daemon restart' };
        lanes.set(ctx.laneId, state.paneId);
        return watch(ctx, state, p, state.turn);
      });
    },

    async cleanup(job) {
      const state = paneStateOf(job);
      if (state) await exitAndClose(state.paneId);
    },
  };
}
