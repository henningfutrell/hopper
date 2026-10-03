// The built-in test executor driven by a sourced job's prompt. A source builds payload
// { prompt, cwd, env, model? }, so the test-executor op travels as JSON on the prompt's FIRST line
// (an issue body like `{"op":"ask","message":"Is this risky?"}`; the issue context follows).
// Registered through AppSeams.executors as "scripted"; it records every payload it ran.
import type { ExecutionContext, Executor } from '../../src/domain/ports.ts';
import { createTestExecutor } from '../../src/executors/index.ts';

export interface ScriptedExecutor extends Executor {
  /** The sourced payloads of every run and resume, in order. */
  readonly payloads: Record<string, unknown>[];
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
  const scripted = (ctx: ExecutionContext): ExecutionContext => {
    payloads.push(ctx.job.spec.payload);
    const op = script(ctx.job.spec.payload) as Record<string, unknown>;
    return { ...ctx, job: { ...ctx.job, spec: { ...ctx.job.spec, payload: op } } };
  };
  return {
    name: 'scripted',
    idempotent: true,
    payloads,
    validate(payload) {
      const s = script(payload);
      return typeof s === 'string' ? s : inner.validate(s);
    },
    run: (ctx) => inner.run(scripted(ctx)),
    resume: (ctx, answer) => inner.resume!(scripted(ctx), answer),
  };
}
