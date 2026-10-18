// The saga coordinator (issue #1524, design.md "Sagas: work that survives a stop"): it drives each saga through its
// steps, one step at a time, and writes each outcome before the next step starts. It holds a saga by its lease, which
// it renews while a step runs; a host that stops renews nothing, so once the lease ends any host's coordinator claims
// the saga and goes on from its last committed step. A step that started and was not recorded done runs again with the
// same idempotency key (`stepKey`): its receiver must do it once. Every pass takes the sagas due (start, then each
// PASS_MS), so a saga a stopped hopper left goes on without anyone asking.
import { compensate, nextOf, newSaga, stepCompensated, stepDone, stepKey, tryFailed, tryStarts, type Saga, type SagaRepository } from '../domain/sagas.ts';
import { killPoint, sagaKillPoint } from './kill-points.ts';

/** What a step's do and compensation get. */
export interface SagaStepContext {
  saga: Saga;
  /** The idempotency key of this step of this saga: the same at each try, on any host. */
  key: string;
  /** The saga's data: its begin's input and the output of each step done before. */
  data: Record<string, unknown>;
  /** Aborted when the saga is aborted, its lease is lost, or the hopper stops: the step ends soon after. */
  signal: AbortSignal;
}

export interface SagaStepDefinition {
  name: string;
  /** The step's effect, idempotent by `key`. What it answers joins the saga's data, kept before the next step. */
  do(c: SagaStepContext): Promise<Record<string, unknown> | void>;
  /** Undoes the step, idempotent too, and a no-op when the do had no effect. Absent: nothing to undo. */
  compensate?(c: SagaStepContext): Promise<void>;
  /** The tries before the saga compensates, or, for the compensation, fails (default SAGA_STEP_ATTEMPTS). */
  attempts?: number;
}

/** A kind of saga: its steps in order. */
export interface SagaDefinition { kind: string; steps: readonly SagaStepDefinition[] }

/** How often the coordinator takes the sagas due. */
export const PASS_MS = 5_000;
/** How long a lease holds without a renewal: the most a stopped host keeps a saga from the others. */
export const LEASE_MS = 60_000;
/** The most sagas one pass takes. */
const PASS_LIMIT = 20;

export interface SagaCoordinatorOptions {
  repo: SagaRepository;
  definitions: readonly SagaDefinition[];
  /** This process: unique per start, so a lease of a hopper that stopped is never taken for its own. */
  owner: string;
  clock: { now(): Date };
  idGen: () => string;
  logger: { info(line: string): void; warn(line: string): void };
  leaseMs?: number;
  /** How often a running step's lease is renewed (default a third of the lease). */
  renewMs?: number;
  passMs?: number;
}

export interface SagaCoordinator {
  /**
   * Keeps a new saga of `kind`, one per kind and `key` (a second begin answers the first), and starts to drive it once the
   * caller's synchronous work is done: a step reads what the caller did right after begin (a move's transaction, issue #1569).
   * Throws for a kind no definition names.
   */
  begin(kind: string, key: string, data: Record<string, unknown>, o?: { userId?: string }): Saga;
  /** Drives the saga now until it ends, waits for its next try, or another host holds it. Its state after. */
  drive(id: string): Promise<Saga | undefined>;
  /** Asks to abort the saga: its done steps are compensated, newest first. Whether it was asked (an ended one is not). */
  abort(id: string, reason: string): boolean;
  /** One pass: each saga due, driven. A pass that runs already is joined. */
  pass(): Promise<void>;
  start(): void;
  /** Ends the passes, stops each step in flight, and releases the leases: another host may go on at once. */
  stop(): Promise<void>;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The step's promise, or its abort, whichever comes first: a step that does not heed its signal holds no stop, abort or
 * lost lease. What it does after is idempotent by its key, and a compensation undoes it.
 */
const untilAborted = <T>(p: Promise<T>, signal: AbortSignal): Promise<T> => new Promise<T>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason as Error); return; }
  const onAbort = (): void => reject(signal.reason as Error);
  signal.addEventListener('abort', onAbort, { once: true });
  p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
});

export function createSagaCoordinator(o: SagaCoordinatorOptions): SagaCoordinator {
  const defs = new Map(o.definitions.map((d) => [d.kind, d]));
  const leaseMs = o.leaseMs ?? LEASE_MS, renewMs = o.renewMs ?? Math.floor(leaseMs / 3);
  const now = (): string => o.clock.now().toISOString();
  const lease = () => ({ owner: o.owner, until: new Date(o.clock.now().getTime() + leaseMs).toISOString() });
  /** The sagas this process drives now, and the abort of the step in flight. */
  const driving = new Map<string, { step?: AbortController; done: Promise<Saga | undefined> }>();
  let stopping = false, timer: ReturnType<typeof setInterval> | undefined, passing: Promise<void> | undefined;

  const run = async (id: string, held: { step?: AbortController }): Promise<Saga | undefined> => {
    let s = o.repo.claim(id, lease(), now());
    if (!s) return o.repo.get(id);
    const def = defs.get(s.kind);
    if (!def) {
      // Another build may know it: left for a hopper that does.
      o.repo.release(id, o.owner);
      return s;
    }
    for (;;) {
      if (stopping) { o.repo.release(id, o.owner); return s; }
      if (s.abort && s.state === 'running') {
        s = compensate(s, `aborted: ${s.abort.reason}`, now());
        if (!o.repo.save(s, o.owner)) return lost(s);
      }
      const next = nextOf(s);
      if (next.act === 'end') { o.repo.release(id, o.owner); return s; }
      if (Date.parse(s.nextAt) > o.clock.now().getTime()) { o.repo.release(id, o.owner); return s; }
      const step = def.steps.find((t) => t.name === next.step);
      s = tryStarts(s, next.step, now());
      if (!o.repo.save(s, o.owner)) return lost(s);
      killPoint(sagaKillPoint(s.kind, next.step, next.act === 'do' ? 'before-do' : 'before-compensate'));
      const ac = new AbortController();
      held.step = ac;
      // The lease is renewed while the step runs; lost, the step is told to end.
      const renew = setInterval(() => {
        try {
          if (!o.repo.claim(id, lease(), now())) ac.abort(new Error('the saga\'s lease was lost'));
        } catch (e) { o.logger.warn(`hopper: saga ${id}: cannot renew its lease: ${messageOf(e)}`); }
      }, renewMs);
      renew.unref();
      const c: SagaStepContext = { saga: s, key: stepKey(s, next.step), data: s.data, signal: ac.signal };
      let answered = false;
      try {
        if (!step) throw new Error(`no step ${next.step} in saga kind ${s.kind}`);
        if (next.act === 'do') s = stepDone(s, next.step, (await untilAborted(step.do(c), ac.signal)) ?? undefined, now());
        else { await untilAborted(step.compensate?.(c) ?? Promise.resolve(), ac.signal); s = stepCompensated(s, next.step, now()); }
        answered = true;
      } catch (e) {
        // A stop is no failure: the try was counted, and the next host runs it again with the same key.
        if (stopping) { clearInterval(renew); o.repo.release(id, o.owner); return s; }
        s = tryFailed(s, next.step, messageOf(e), now(), step?.attempts);
        o.logger.warn(`hopper: saga ${s.kind} ${id}: ${next.act === 'do' ? 'step' : 'compensation of'} ${next.step} failed: ${messageOf(e)}`);
      } finally {
        clearInterval(renew);
        delete held.step;
      }
      // An abort asked while the step ran is read before the next one.
      const abort = o.repo.get(id)?.abort;
      if (abort) s = { ...s, abort };
      // The step's effect is made and not yet recorded: a crash here runs it again, with the same key, on the next host.
      if (answered) killPoint(sagaKillPoint(s.kind, next.step, next.act === 'do' ? 'after-do' : 'after-compensate'));
      if (!o.repo.save(s, o.owner)) return lost(s);
    }
  };
  const lost = (s: Saga): Saga => {
    o.logger.warn(`hopper: saga ${s.kind} ${s.id}: another host holds it now; this one leaves it`);
    return s;
  };

  const drive = (id: string): Promise<Saga | undefined> => {
    const running = driving.get(id);
    if (running) return running.done;
    const held: { step?: AbortController } = {};
    const done = run(id, held).finally(() => driving.delete(id));
    driving.set(id, Object.assign(held, { done }));
    return done;
  };
  const kick = (id: string): void => {
    drive(id).catch((e: unknown) => o.logger.warn(`hopper: saga ${id}: ${messageOf(e)}; the next pass tries again`));
  };

  const pass = (): Promise<void> => (passing ??= (async () => {
    // A saga due that a drive here still holds (one that just found it held elsewhere) is driven again after it.
    const due = o.repo.due(now(), PASS_LIMIT).filter((s) => defs.has(s.kind));
    await Promise.allSettled(due.map((s) => (driving.get(s.id)?.done ?? Promise.resolve()).then(() => drive(s.id))));
  })().catch((e: unknown) => o.logger.warn(`hopper: the saga pass failed: ${messageOf(e)}`)).finally(() => { passing = undefined; }));

  return {
    begin(kind, key, data, b = {}) {
      const def = defs.get(kind);
      if (!def) throw new Error(`no saga kind ${kind}`);
      const s = o.repo.begin(newSaga({ id: o.idGen(), kind, key, ...(b.userId !== undefined ? { userId: b.userId } : {}), steps: def.steps.map((t) => t.name), data, at: now() }));
      queueMicrotask(() => { if (!stopping) kick(s.id); });
      return s;
    },
    drive,
    abort(id, reason) {
      const asked = o.repo.requestAbort(id, { at: now(), reason });
      const running = driving.get(id);
      if (asked && running?.step) running.step.abort(new Error(`aborted: ${reason}`));
      else if (asked && !stopping) kick(id);
      return asked;
    },
    pass,
    start() {
      if (timer || stopping) return;
      void pass();
      timer = setInterval(() => { void pass(); }, o.passMs ?? PASS_MS);
      timer.unref();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const d of driving.values()) d.step?.abort(new Error('the hopper stops'));
      await Promise.allSettled([passing, ...[...driving.values()].map((d) => d.done)]);
    },
  };
}
