// Sagas (issue #1524, design.md "Sagas: work that survives a stop"): work that crosses a process, machine or system
// boundary, kept as a record of steps in the database, so that it goes on after a restart, a crash or the loss of the
// host that started it, from its last committed step. A step that is done is never done again; a step that may have
// started is done again with the same idempotency key, so its receiver does it once. A saga that cannot end, or that a
// person aborts, runs the compensation of each step it did, newest first. Pure: the coordinator (src/sagas/) runs it.

/**
 * `running`: its steps are done in order; `compensating`: its done steps are undone, newest first; `done`: every step
 * is done; `compensated`: every step it did is undone; `failed`: a compensation failed past its attempts, and a person
 * must look.
 */
export type SagaState = 'running' | 'compensating' | 'done' | 'compensated' | 'failed';

/** `pending`: not done yet (it may have started); `done`; `compensated`: undone, or nothing to undo. */
export type SagaStepState = 'pending' | 'done' | 'compensated';

export interface SagaStep {
  name: string;
  state: SagaStepState;
  /** The tries of this step's do, then of its compensation: each start counts, so a try a stop cut short counts too. */
  attempts: number;
  /** Its do started at least once: it may have had an effect, so a compensation undoes it too. */
  started?: true;
  lastError?: string;
  doneAt?: string;
  compensatedAt?: string;
}

export interface Saga {
  id: string;
  /** Its definition's name: the coordinator runs the steps that definition names. */
  kind: string;
  /** The idempotency key of the saga: one saga per kind and key, so a second begin answers the first. */
  key: string;
  /** The user it works for, when it works for one. */
  userId?: string;
  state: SagaState;
  steps: SagaStep[];
  /**
   * What its steps need and made, kept with it (an id a step got back, a session to resume): no step reads state that
   * lives only on the host that ran an earlier step. Its begin's input, then each step's output merged in.
   */
  data: Record<string, unknown>;
  /** A person or the hopper asked to abort it: its done steps are compensated. */
  abort?: { at: string; reason: string };
  /** Why it compensates or failed: the last error of the step that could not be done, or the abort's reason. */
  error?: string;
  /** Not before this time is its next try (the backoff after a failed try). */
  nextAt: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

/** A host's hold on a saga: until `until`, no other host drives it. It ends with the host, so another host claims it. */
export interface SagaLease { owner: string; until: string }

/** The sagas, in the instance's `sagas` table. */
export interface SagaRepository {
  /** Keeps a new saga; one of the same kind and key kept already is answered instead, unchanged. */
  begin(saga: Saga): Saga;
  get(id: string): Saga | undefined;
  /**
   * Takes or renews the lease of a saga not ended, when no other owner holds one until after `now`. The saga, else
   * undefined (another host holds it, or it ended).
   */
  claim(id: string, lease: SagaLease, now: string): Saga | undefined;
  /** Writes the saga only while `owner` holds its lease; whether it was written. An ended saga's lease is released. */
  save(saga: Saga, owner: string): boolean;
  /** Releases `owner`'s lease. */
  release(id: string, owner: string): void;
  /** Records an abort, whoever holds the lease: the holder reads it before its next step. Whether it was recorded. */
  requestAbort(id: string, abort: { at: string; reason: string }): boolean;
  /** The sagas not ended whose next try is due by `now` and that no other owner holds: oldest first. */
  due(now: string, limit: number): Saga[];
  /** The sagas not ended, oldest first. */
  open(): Saga[];
}

/** The tries a step gets before its saga compensates (a do), or fails (a compensation). */
export const SAGA_STEP_ATTEMPTS = 5;
const BACKOFF_FIRST_MS = 1_000, BACKOFF_MOST_MS = 5 * 60_000;

/** The wait before try `attempts + 1`: doubling from a second, five minutes at most. */
export const sagaBackoffMs = (attempts: number): number => Math.min(BACKOFF_MOST_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, attempts - 1));

/** The idempotency key a step's receiver dedupes by: the same for each try of that step of that saga. */
export const stepKey = (saga: Pick<Saga, 'id'>, step: string): string => `${saga.id}/${step}`;

/** A new saga of `steps`, in their order, none done. */
export function newSaga(o: { id: string; kind: string; key: string; userId?: string; steps: readonly string[]; data: Record<string, unknown>; at: string }): Saga {
  return {
    id: o.id, kind: o.kind, key: o.key, ...(o.userId !== undefined ? { userId: o.userId } : {}), state: 'running',
    steps: o.steps.map((name) => ({ name, state: 'pending', attempts: 0 })), data: { ...o.data },
    nextAt: o.at, createdAt: o.at, updatedAt: o.at,
  };
}

export const sagaEnded = (s: Pick<Saga, 'state'>): boolean => s.state === 'done' || s.state === 'compensated' || s.state === 'failed';

/** What the coordinator does next with a saga: one step's do, one step's compensation, or nothing (it ended). */
export type SagaNext = { act: 'do' | 'compensate'; step: string } | { act: 'end' };

export function nextOf(s: Saga): SagaNext {
  if (sagaEnded(s)) return { act: 'end' };
  if (s.state === 'running') {
    const step = s.steps.find((t) => t.state === 'pending');
    return step ? { act: 'do', step: step.name } : { act: 'end' };
  }
  // Compensating, newest first: each step done, and the step whose do may have started.
  const step = [...s.steps].reverse().find((t) => t.state === 'done' || (t.state === 'pending' && t.started));
  return step ? { act: 'compensate', step: step.name } : { act: 'end' };
}

const withStep = (s: Saga, name: string, f: (t: SagaStep) => SagaStep): SagaStep[] => s.steps.map((t) => (t.name === name ? f(t) : t));

/** A try of `step` starts (a do, or a compensation): counted before it runs, so a stop mid-try is counted. */
export const tryStarts = (s: Saga, step: string, at: string): Saga =>
  ({ ...s, steps: withStep(s, step, (t) => ({ ...t, attempts: t.attempts + 1, started: true })), updatedAt: at });

/** The step's do went through: its output joins the saga's data, and the saga ends done when no step is left. */
export function stepDone(s: Saga, step: string, output: Record<string, unknown> | undefined, at: string): Saga {
  const steps = withStep(s, step, (t) => ({ name: t.name, state: 'done', attempts: 0, started: true, doneAt: at }));
  const next: Saga = { ...s, steps, data: { ...s.data, ...output }, nextAt: at, updatedAt: at };
  return steps.every((t) => t.state === 'done') ? { ...next, state: 'done', endedAt: at } : next;
}

/** The step's compensation went through; the saga ends compensated when nothing is left to undo. */
export function stepCompensated(s: Saga, step: string, at: string): Saga {
  const next: Saga = { ...s, steps: withStep(s, step, (t) => ({ ...t, state: 'compensated', compensatedAt: at })), nextAt: at, updatedAt: at };
  return nextOf(next).act === 'end' ? { ...next, state: 'compensated', endedAt: at } : next;
}

/**
 * A try failed. Under its attempts it is tried again after the backoff; past them a do turns the saga to compensating,
 * and a compensation ends it failed, for a person.
 */
export function tryFailed(s: Saga, step: string, error: string, at: string, attempts = SAGA_STEP_ATTEMPTS): Saga {
  const t = s.steps.find((x) => x.name === step);
  const tries = t?.attempts ?? 0;
  const steps = withStep(s, step, (x) => ({ ...x, lastError: error }));
  if (tries < attempts) return { ...s, steps, nextAt: new Date(Date.parse(at) + sagaBackoffMs(tries)).toISOString(), updatedAt: at };
  if (s.state === 'running') return compensate({ ...s, steps }, `step ${step} failed: ${error}`, at);
  return { ...s, steps, state: 'failed', error: `compensation of step ${step} failed: ${error}`, nextAt: at, updatedAt: at, endedAt: at };
}

/**
 * The saga turns to compensating: an abort, or a do past its attempts. The tries are counted again for each
 * compensation; the step whose do may have started is compensated too.
 */
export function compensate(s: Saga, reason: string, at: string): Saga {
  if (sagaEnded(s) || s.state === 'compensating') return s;
  const steps = s.steps.map((t) => ({ ...t, attempts: 0 }));
  const next: Saga = { ...s, steps, state: 'compensating', error: reason, nextAt: at, updatedAt: at };
  return nextOf(next).act === 'end' ? { ...next, state: 'compensated', endedAt: at } : next;
}
