// The built-in test executor driven by a sourced job's prompt. A source builds payload
// { prompt, cwd, env, model? }, so the test-executor op travels as JSON on the prompt's FIRST line
// (an issue body like `{"op":"ask","message":"Is this risky?"}`; the issue context follows).
// Registered through AppSeams.executors as "scripted"; it records every payload it ran. An op may
// carry `progress: number[]`: each fraction is reported (job.progressed) before the op runs.
// `ships(fn)` plays a job that ships its work (issue #171): fn runs (a test merges the job's pull
// request in the fake GitHub) before each finished outcome is returned.
import type { ExecutionContext, ExecutionOutcome, Executor } from '../../src/domain/ports.ts';
import type { Job } from '../../src/domain/types.ts';
import { createTestExecutor } from '../../src/executors/index.ts';
import type { FakeGitHub } from '../../src/sources/index.ts';

export interface ScriptedExecutor extends Executor {
  /** The sourced payloads of every run and resume, in order. */
  readonly payloads: Record<string, unknown>[];
  /** From now on, every job that finishes ships first: `fn(job)` runs before the outcome returns. */
  ships(fn: (job: Job) => void): void;
}

function script(payload: Record<string, unknown>): Record<string, unknown> | string {
  if (typeof payload.prompt !== 'string') return 'prompt must be a string';
  const first = payload.prompt.split('\n', 1)[0]!.trim();
  try {
    const parsed: unknown = JSON.parse(first);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'the first prompt line must be a JSON object';
    return parsed as Record<string, unknown>;
  } catch {
    return 'the first prompt line must be a JSON object';
  }
}

export function createScriptedExecutor(): ScriptedExecutor {
  const inner = createTestExecutor();
  const payloads: Record<string, unknown>[] = [];
  let ship: ((job: Job) => void) | undefined;
  const shipped = async (ctx: ExecutionContext, outcome: Promise<ExecutionOutcome>): Promise<ExecutionOutcome> => {
    const o = await outcome;
    if (o.kind === 'finished') ship?.(ctx.job);
    return o;
  };
  const scripted = (ctx: ExecutionContext): ExecutionContext => {
    payloads.push(ctx.job.spec.payload);
    const op = script(ctx.job.spec.payload) as Record<string, unknown>;
    return { ...ctx, job: { ...ctx.job, spec: { ...ctx.job.spec, payload: op } } };
  };
  return {
    name: 'scripted',
    idempotent: true,
    payloads,
    ships(fn) { ship = fn; },
    validate(payload) {
      const s = script(payload);
      return typeof s === 'string' ? s : inner.validate(s);
    },
    run: (ctx) => {
      const op = scripted(ctx);
      const steps = op.job.spec.payload.progress;
      if (Array.isArray(steps)) for (const f of steps) ctx.progress(Number(f), `step ${String(f)}`);
      return shipped(ctx, inner.run(op));
    },
    resume: (ctx, answer) => shipped(ctx, inner.resume!(scripted(ctx), answer)),
  };
}

/** For `ships`: the job's pull request, opened and merged now, closes its issue in the fake GitHub. */
export const mergesPullRequest = (gh: FakeGitHub) => (job: Job): void => {
  const now = new Date().toISOString();
  gh.closeByPullRequest(job.source!.repo!, job.source!.number!, { createdAt: now, mergedAt: now });
};

/** For `ships`: the job's pull request, opened now and ready for review, will close its issue when merged. */
export const opensPullRequest = (gh: FakeGitHub) => (job: Job): void => {
  gh.openPullRequest(job.source!.repo!, job.source!.number!, { createdAt: new Date().toISOString() });
};
