// Doubles at the Answerer and Assessor seams, for tests (AppSeams.answerer, .assessor). Not
// plugins: nothing in plugins.yaml can select them. Scripts may be async; a throw comes back as
// `{ error }`. The assessor double returns whatever its script returns, so a test can hand the
// question service a malformed assessment.
import type { AnswerDraft, AnswerRequest, Answerer, Assessment, Assessor } from '../domain/ports.ts';

type Result<T> = T | { error: string };
const failure = (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) });

export function createFakeAnswerer(o: {
  name: string;
  model?: string;
  script: (req: AnswerRequest, signal: AbortSignal) => Result<AnswerDraft> | Promise<Result<AnswerDraft>>;
}): Answerer {
  return {
    name: o.name,
    model: o.model ?? `fake-${o.name}`,
    async answer(req, signal) {
      try {
        return await o.script(req, signal);
      } catch (err) {
        return failure(err);
      }
    },
  };
}

export function createFakeAssessor(o: {
  name: string;
  model?: string;
  script: (req: AnswerRequest, draft: AnswerDraft, signal: AbortSignal) => Result<Assessment> | Promise<Result<Assessment>>;
}): Assessor {
  return {
    name: o.name,
    model: o.model ?? `fake-${o.name}`,
    async assess(req, draft, signal) {
      try {
        return await o.script(req, draft, signal);
      } catch (err) {
        return failure(err);
      }
    },
  };
}
