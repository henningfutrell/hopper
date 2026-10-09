// The built-in "test" executor: sleep / echo / fail / ask / fail-after-answer / propose / research, per
// docs/design.md "Test executor" and "Test executor additions". Idempotent; never rejects. `propose` (issue #537) comes
// back with `message` as its proposal; resumed (it was sent back), with a revision that quotes what it was told.
// `research` (issue #543) comes back with `message` as its research report; resumed, with the next round that quotes
// what it was told — or, told to write a proposal next (its research accepted), with a proposal.

import type { ExecutionContext, ExecutionOutcome, Executor } from '../domain/ports.ts';

const OPS = ['sleep', 'echo', 'fail', 'ask', 'fail-after-answer', 'propose', 'research'] as const;
const MAX_MS = 600000;
const ABORTED: ExecutionOutcome = { kind: 'failed', error: 'aborted' };

interface TestPayload { op: (typeof OPS)[number]; ms?: number; message?: string }

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
  return { kind: 'finished', result: { slept: ms } };
}

export function createTestExecutor(): Executor {
  return {
    name: 'test',
    idempotent: true,
    validate(payload) {
      if (!OPS.includes(payload.op as (typeof OPS)[number])) return `op must be one of ${OPS.join(', ')}`;
      const { ms } = payload;
      if (ms === undefined) return null;
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'ms must be a non-negative number';
      if (ms > MAX_MS) return `ms must be at most ${MAX_MS}`;
      return null;
    },
    async run(ctx) {
      const { op, ms, message } = ctx.job.spec.payload as unknown as TestPayload;
      if (op === 'sleep') return runSleep(ctx, ms ?? 1000);
      if (!(await wait(ms ?? 0, ctx.signal))) return ABORTED;
      if (op === 'echo') return { kind: 'finished', result: { echo: message } };
      if (op === 'fail') return { kind: 'failed', error: message ?? 'failed on purpose' };
      ctx.saveState({ asked: true });
      if (op === 'propose') return { kind: 'report', review: 'proposal', report: { text: message ?? 'Goal: something', recentOutput: '' } };
      if (op === 'research') return { kind: 'report', review: 'research', report: { text: message ?? 'Findings: something', recentOutput: '' } };
      return { kind: 'question', question: { text: message ?? 'Which option?', recentOutput: '', detectedBy: 'test' } };
    },
    async resume(ctx, answer) {
      const { op, ms, message } = ctx.job.spec.payload as unknown as TestPayload;
      if (!(await wait(ms ?? 0, ctx.signal))) return ABORTED;
      if (op === 'fail-after-answer') return { kind: 'failed', error: `failed after answer: ${answer}` };
      if (op === 'propose') return { kind: 'report', review: 'proposal', report: { text: `${message ?? 'Goal: something'}\nRevised after: ${answer}`, recentOutput: '' } };
      if (op === 'research' && answer.includes('HOPPER_PROPOSAL')) return { kind: 'report', review: 'proposal', report: { text: 'Goal: act on the research', recentOutput: '' } };
      if (op === 'research') return { kind: 'report', review: 'research', report: { text: `${message ?? 'Findings: something'}\nRound after: ${answer}`, recentOutput: '' } };
      return { kind: 'finished', result: { answer } };
    },
  };
}
