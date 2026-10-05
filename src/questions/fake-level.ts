// A double at the EscalationLevel seam, for tests (AppSeams.levels). Not a plugin: nothing in
// plugins.yaml can select it. The script may be async; a throw comes back as `{ error }`. It returns
// whatever its script returns, so a test can hand the question service a malformed reply.
import type { AnswerRequest, EscalationLevel, LevelReply } from '../domain/ports.ts';

type Result<T> = T | { error: string };

export function createFakeLevel(o: {
  name: string;
  model?: string;
  script: (req: AnswerRequest, signal: AbortSignal) => Result<LevelReply> | Promise<Result<LevelReply>>;
}): EscalationLevel {
  return {
    name: o.name,
    model: o.model ?? `fake-${o.name}`,
    async answer(req, signal) {
      try {
        return await o.script(req, signal);
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
