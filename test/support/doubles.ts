// Executor doubles for engine integration tests, injected through AppSeams. They implement
// the Executor port only; nothing in the engine is mocked.
import type { ExecutionOutcome, Executor } from '../../src/domain/ports.ts';
import type { Job } from '../../src/domain/types.ts';

export interface StickyExecutor extends Executor {
  /** Job ids run() was called for, in order. */
  readonly runs: string[];
  /** signal.reason of every abort seen. */
  readonly abortReasons: unknown[];
  /** Job ids cleanup() was called for. */
  readonly cleaned: string[];
}

/** Not idempotent (like herdr-claude): runs until aborted, records how it was stopped. `kept`: what its reap keeps (issue #401). */
export function createStickyExecutor(o: { kept?: string[] } = {}): StickyExecutor {
  const runs: string[] = [];
  const abortReasons: unknown[] = [];
  const cleaned: string[] = [];
  return {
    name: 'sticky',
    idempotent: false,
    runs, abortReasons, cleaned,
    validate: () => null,
    run(ctx) {
      runs.push(ctx.job.id);
      ctx.saveState({ pane: `pane-${ctx.job.id}` });
      return new Promise<ExecutionOutcome>((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          abortReasons.push(ctx.signal.reason);
          resolve({ kind: 'failed', error: 'aborted' });
        }, { once: true });
      });
    },
    async cleanup(job: Job) {
      cleaned.push(job.id);
      return o.kept ? { kept: o.kept } : undefined;
    },
  };
}

export interface AskerExecutor extends Executor {
  readonly answers: string[];
  readonly cleaned: string[];
}

/** Asks on every run and every resume: drives the question budget. */
export function createAskerExecutor(): AskerExecutor {
  const answers: string[] = [];
  const cleaned: string[] = [];
  const ask = (n: number): ExecutionOutcome => ({
    kind: 'question', question: { text: `Question number ${n}?`, recentOutput: '', detectedBy: 'test' },
  });
  return {
    name: 'asker',
    answers, cleaned,
    validate: () => null,
    async run(ctx) {
      ctx.saveState({ asked: 1 });
      return ask(1);
    },
    async resume(ctx, answer) {
      answers.push(answer);
      return ask(answers.length + 1);
    },
    async cleanup(job) {
      cleaned.push(job.id);
    },
  };
}
