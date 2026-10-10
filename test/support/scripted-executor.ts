// The built-in test executor driven by a sourced job's prompt. A source builds payload
// { prompt, cwd, env, model? }, so the test-executor op travels as JSON on the first line of the issue body
// (an issue body like `{"op":"ask","message":"Is this risky?"}`): the prompt's first line, or the body's first line
// inside the untrusted block of a GitHub issue's prompt (issue #652).
// Registered through AppSeams.executors as "scripted"; it records every payload it ran. An op may
// carry `progress: number[]`: each fraction is reported (job.progressed) before the op runs.
// `ships(fn)` plays a job that ships its work (issue #171): fn runs (a test merges the job's pull
// request in the fake GitHub) before each finished outcome is returned. The op `before-nudge` (issue #627) ships, then
// asks the engine's check before a nudge, keeps its answer in `checks`, and finishes.
import type { ExecutionContext, ExecutionOutcome, Executor, NudgeCheck } from '../../src/domain/ports.ts';
import type { Job } from '../../src/domain/types.ts';
import { createTestExecutor } from '../../src/executors/index.ts';
import { UNTRUSTED_LINE } from '../../src/sources/github/context.ts';
import type { FakeGitHub } from '../../src/sources/index.ts';

export interface ScriptedExecutor extends Executor {
  /** The sourced payloads of every run and resume, in order. */
  readonly payloads: Record<string, unknown>[];
  /** From now on, every job that finishes ships first: `fn(job)` runs before the outcome returns. */
  ships(fn: (job: Job) => void): void;
  /** What each `before-nudge` op was answered, in order. */
  readonly checks: NudgeCheck[];
}

function script(payload: Record<string, unknown>): Record<string, unknown> | string {
  if (typeof payload.prompt !== 'string') return 'prompt must be a string';
  const lines = payload.prompt.split('\n');
  const at = lines[0] === UNTRUSTED_LINE ? lines.indexOf('') + 1 : 0; // after the block's marker and the title line
  const first = (lines[at] ?? '').trim();
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
  const checks: NudgeCheck[] = [];
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
    reviews: true,
    payloads,
    checks,
    ships(fn) { ship = fn; },
    validate(payload) {
      const s = script(payload);
      if (typeof s === 'string') return s;
      return s.op === 'before-nudge' ? null : inner.validate(s);
    },
    run: async (ctx) => {
      const op = scripted(ctx);
      if (op.job.spec.payload.op === 'before-nudge') {
        ship?.(ctx.job);
        checks.push(await ctx.beforeNudge!());
        return { kind: 'finished', result: {} };
      }
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

/** For `ships`: the job's pull request that ships part of its issue ("Part of #N"), opened now and ready for review. */
export const opensPartPullRequest = (gh: FakeGitHub) => (job: Job): void => {
  gh.openPartPullRequest(job.source!.repo!, job.source!.number!, { createdAt: new Date().toISOString() });
};
