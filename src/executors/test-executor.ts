// The built-in "test" executor: sleep / echo / fail, per docs/design.md "Test executor".
//
// Executor contract, for a future "herdr-claude" executor: it implements the same
// interface. run() spawns the process, maps ctx.signal to killing it, derives
// ctx.progress from the process output, and resolves { ok:false, error } on any failure.
// It never rejects.

import type { ExecutionContext, ExecutionOutcome, Executor } from '../domain/ports.ts';

const OPS = ['sleep', 'echo', 'fail'] as const;
const MAX_MS = 600000;
const ABORTED: ExecutionOutcome = { ok: false, error: 'aborted' };

/** Resolves true after ms, or false as soon as the signal fires. */
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function runSleep(ctx: ExecutionContext, ms: number): Promise<ExecutionOutcome> {
  const step = ms / 10;
  for (let i = 1; i <= 10; i++) {
    if (!(await wait(step, ctx.signal))) return ABORTED;
    ctx.progress(i / 10);
  }
  return { ok: true, result: { slept: ms } };
}

export function createTestExecutor(): Executor {
  return {
    name: 'test',
    validate(payload) {
      if (!OPS.includes(payload.op as (typeof OPS)[number])) return `op must be one of ${OPS.join(', ')}`;
      const { ms } = payload;
      if (ms === undefined) return null;
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'ms must be a non-negative number';
      if (ms > MAX_MS) return `ms must be at most ${MAX_MS}`;
      return null;
    },
    async run(ctx) {
      const { op, ms, message } = ctx.job.spec.payload as { op: string; ms?: number; message?: string };
      if (op === 'sleep') return runSleep(ctx, ms ?? 1000);
      if (!(await wait(ms ?? 0, ctx.signal))) return ABORTED;
      if (op === 'echo') return { ok: true, result: { echo: message } };
      return { ok: false, error: message ?? 'failed on purpose' };
    },
  };
}
