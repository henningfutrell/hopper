// The question doubles every integration test runs with unless it passes its own seams: no model
// is called. The answerer `opus` drafts `fake opus answer`, confident unless the question says
// "unsure". The assessor `fable` escalates when the question says "risky" or "hard". The risk rules
// apply on top, as for real plugins (a question about deleting reaches the human).
import type { Answerer, Assessor } from '../../src/domain/ports.ts';
import { createFakeAnswerer, createFakeAssessor } from '../../src/questions/index.ts';

export function fakeQuestionRoles(): { answerer: Answerer; assessor: Assessor } {
  return {
    answerer: createFakeAnswerer({
      name: 'opus',
      script: (req) => {
        const confident = !/\bunsure\b/i.test(req.question.text);
        return { answer: 'fake opus answer', confident, reason: `fake opus: confident=${confident}` };
      },
    }),
    assessor: createFakeAssessor({
      name: 'fable',
      script: (req) => {
        const escalate = /\b(risky|hard)\b/i.test(req.question.text);
        return { escalate, reason: `fake fable: escalate=${escalate}` };
      },
    }),
  };
}
