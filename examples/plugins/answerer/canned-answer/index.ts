// An answerer: drafts an answer to a question a job asked. The assessor then decides whether
// The owner must see it, and the risk rules still apply. This one always drafts the same text.
//   answerer: { name: canned, plugin: canned-answer, options: { answer: "Yes, go ahead." } }
import type { PluginDefinition } from 'job-hopper/plugin';

export default {
  id: 'canned-answer',
  role: 'answerer',
  describe: 'Drafts one fixed answer to every question',
  options: (z) => z.object({
    answer: z.string().default('Use your best judgement and continue.'),
    // Not confident → the question goes straight to the human.
    confident: z.boolean().default(false),
  }),
  async detect() { return { status: 'available' }; },
  create(ctx, options) {
    return {
      name: ctx.instanceName,
      // `signal` aborts when the question service's stage timeout passes; honour it in real work.
      async answer(req) {
        return { answer: options.answer, confident: options.confident, reason: `canned answer to: ${req.question.text.slice(0, 80)}` };
      },
    };
  },
} satisfies PluginDefinition<'answerer'>;
