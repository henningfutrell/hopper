import { describe, expect, it } from 'vitest';
import { createExecutorRegistry, createTestExecutor } from '../../src/executors/index.ts';
import type { ExecutionContext } from '../../src/domain/ports.ts';
import type { Job } from '../../src/domain/types.ts';

function ctxFor(payload: Record<string, unknown>, signal = new AbortController().signal) {
  const progress: number[] = [];
  const saved: Record<string, unknown>[] = [];
  const job: Job = {
    id: 'j1', spec: { executor: 'test', payload }, priority: 50, status: 'running', approved: false,
    createdAt: '', updatedAt: '', attempts: 1,
  };
  const ctx: ExecutionContext = { job, laneId: 'local/lane-1', signal, progress: (f) => progress.push(f), saveState: (s) => saved.push(s) };
  return { ctx, progress, saved };
}

describe('test executor', () => {
  const ex = createTestExecutor();

  it('is named test', () => expect(ex.name).toBe('test'));

  it('echo returns the message', async () => {
    expect(await ex.run(ctxFor({ op: 'echo', message: 'hi' }).ctx)).toEqual({ kind: 'finished', result: { echo: 'hi' } });
  });

  it('fail reports the message, or a default', async () => {
    expect(await ex.run(ctxFor({ op: 'fail', message: 'boom' }).ctx)).toEqual({ kind: 'failed', error: 'boom' });
    expect(await ex.run(ctxFor({ op: 'fail' }).ctx)).toEqual({ kind: 'failed', error: 'failed on purpose' });
  });

  it('sleep reports increasing progress and its result', async () => {
    const { ctx, progress } = ctxFor({ op: 'sleep', ms: 100 });
    expect(await ex.run(ctx)).toEqual({ kind: 'finished', result: { slept: 100 } });
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    expect(progress.every((p) => p > 0 && p <= 1)).toBe(true);
  });

  it('abort mid-sleep resolves aborted within 100 ms', async () => {
    const ac = new AbortController();
    const { ctx } = ctxFor({ op: 'sleep', ms: 5000 }, ac.signal);
    const p = ex.run(ctx);
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    ac.abort();
    expect(await p).toEqual({ kind: 'failed', error: 'aborted' });
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('an already-aborted signal resolves aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await ex.run(ctxFor({ op: 'echo', ms: 1000 }, ac.signal).ctx)).toEqual({ kind: 'failed', error: 'aborted' });
  });

  it('is idempotent and can resume', () => {
    expect(ex.idempotent ?? true).toBe(true);
    expect(typeof ex.resume).toBe('function');
  });

  it('ask returns a question with the message, or a default, and saves its state', async () => {
    const { ctx, saved } = ctxFor({ op: 'ask', message: 'Red or blue?' });
    expect(await ex.run(ctx)).toEqual({
      kind: 'question', question: { text: 'Red or blue?', recentOutput: '', detectedBy: 'test' },
    });
    expect(saved).toEqual([{ asked: true }]);
    const plain = await ex.run(ctxFor({ op: 'ask' }).ctx);
    expect(plain).toMatchObject({ kind: 'question', question: { text: 'Which option?' } });
  });

  it('resume finishes with the answer; fail-after-answer fails on resume', async () => {
    expect(await ex.resume!(ctxFor({ op: 'ask' }).ctx, 'blue')).toEqual({ kind: 'finished', result: { answer: 'blue' } });
    const asked = await ex.run(ctxFor({ op: 'fail-after-answer' }).ctx);
    expect(asked.kind).toBe('question');
    const failed = await ex.resume!(ctxFor({ op: 'fail-after-answer' }).ctx, 'blue');
    expect(failed.kind).toBe('failed');
  });

  it('resume honours ms and abort', async () => {
    const ac = new AbortController();
    const p = ex.resume!(ctxFor({ op: 'ask', ms: 5000 }, ac.signal).ctx, 'x');
    ac.abort('cancel');
    expect(await p).toEqual({ kind: 'failed', error: 'aborted' });
  });

  it('validate rejects bad op and bad ms', () => {
    expect(ex.validate({ op: 'ask' })).toBeNull();
    expect(ex.validate({ op: 'fail-after-answer' })).toBeNull();
    expect(ex.validate({ op: 'echo' })).toBeNull();
    expect(ex.validate({ op: 'sleep', ms: 600000 })).toBeNull();
    expect(ex.validate({ op: 'nope' })).toEqual(expect.any(String));
    expect(ex.validate({})).toEqual(expect.any(String));
    expect(ex.validate({ op: 'sleep', ms: '5' })).toEqual(expect.any(String));
    expect(ex.validate({ op: 'sleep', ms: -1 })).toEqual(expect.any(String));
    expect(ex.validate({ op: 'sleep', ms: 600001 })).toEqual(expect.any(String));
  });
});

describe('executor registry', () => {
  it('gets by name and lists names', () => {
    const ex = createTestExecutor();
    const reg = createExecutorRegistry([ex], []);
    expect(reg.get('test')).toBe(ex);
    expect(reg.get('x')).toBeUndefined();
    expect(reg.names()).toEqual(['test']);
    expect(reg.unavailable()).toEqual([]);
  });
  it('knows the configured executors that cannot run, and why; they are not gettable', () => {
    const reg = createExecutorRegistry([createTestExecutor()], [{ name: 'herdr-claude', reason: 'herdr not found: herdr' }]);
    expect(reg.get('herdr-claude')).toBeUndefined();
    expect(reg.names()).toEqual(['test']);
    expect(reg.unavailable()).toEqual([{ name: 'herdr-claude', reason: 'herdr not found: herdr' }]);
  });
  it('throws on a duplicate name, available or not', () => {
    expect(() => createExecutorRegistry([createTestExecutor(), createTestExecutor()], [])).toThrow(/duplicate/i);
    expect(() => createExecutorRegistry([createTestExecutor()], [{ name: 'test', reason: 'x' }])).toThrow(/duplicate/i);
  });
});
