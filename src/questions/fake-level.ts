// A double at the EscalationLevel seam, for tests (AppSeams.levels). Not a plugin: nothing in
// the plugins config can select it. The script may be async; a throw comes back as `{ error }`. It returns
// whatever its script returns, so a test can hand the question service a malformed reply. `review` (issue #537): the
// level's proposal reviews; absent, it approves every one.
import type { AnswerRequest, EscalationLevel, LevelReply, ReviewReply, ReviewRequest } from '../domain/ports.ts';

type Result<T> = T | { error: string };

export function createFakeLevel(o: {
  name: string;
  model?: string;
  script: (req: AnswerRequest, signal: AbortSignal) => Result<LevelReply> | Promise<Result<LevelReply>>;
  review?: (req: ReviewRequest, signal: AbortSignal) => Result<ReviewReply> | Promise<Result<ReviewReply>>;
}): EscalationLevel {
  const guarded = async <T>(fn: () => Result<T> | Promise<Result<T>>): Promise<Result<T>> => {
    try {
      return await fn();
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
  return {
    name: o.name,
    model: o.model ?? `fake-${o.name}`,
    answer: (req, signal) => guarded(() => o.script(req, signal)),
    review: (req, signal) => guarded(() => (o.review ? o.review(req, signal) : { verdict: 'approve' as const, notes: `fake ${o.name}: approve` })),
  };
}
