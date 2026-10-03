import type { AnswerRequest, AnswerVerdict, Answerer } from '../domain/ports.ts';

type Result = AnswerVerdict | { error: string };

/** Scripted tier for tests and `JOB_HOPPER_ANSWERER=fake`. The script may be async. */
export function createFakeAnswerer(o: {
  tier: Answerer['tier'];
  model?: string;
  script: (req: AnswerRequest, signal: AbortSignal) => Result | Promise<Result>;
}): Answerer {
  return {
    tier: o.tier,
    model: o.model ?? `fake-${o.tier}`,
    async answer(req, signal) {
      try {
        return await o.script(req, signal);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
