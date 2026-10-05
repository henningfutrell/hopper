// An escalation level: answers a question a job asked, or escalates it to the level above (the
// owner, above the top level). The risk rules still apply to an answer. This one answers every
// question with the same text, and escalates one that names a listed word, recommending that text.
// The core fails closed: anything but a valid `escalate: false` with an answer escalates.
//   escalationLevels:
//     - { name: canned, plugin: canned-answer, options: { answer: "Yes, go ahead.", words: [delete, deploy] } }
import type { PluginDefinition } from 'hopper/plugin';

export default {
  id: 'canned-answer',
  role: 'escalation-level',
  describe: 'Answers every question with one fixed text; escalates a question that names a listed word',
  options: (z) => z.object({
    answer: z.string().min(1).default('Use your best judgement and continue.'),
    words: z.array(z.string()).default(['delete', 'deploy', 'password']),
  }),
  async detect() { return { status: 'available' }; },
  create(ctx, options) {
    return {
      name: ctx.instanceName,
      // `signal` aborts when the question service's stage timeout passes; honour it in real work.
      async answer(req) {
        const text = req.question.text.toLowerCase();
        const hit = options.words.find((w) => text.includes(w.toLowerCase()));
        if (hit) return { answer: options.answer, escalate: true, reason: `the question mentions "${hit}"` };
        return { answer: options.answer, escalate: false, reason: `canned answer to: ${req.question.text.slice(0, 80)}` };
      },
    };
  },
} satisfies PluginDefinition<'escalation-level', { answer: string; words: string[] }>; // the options type, so `words` is typed
