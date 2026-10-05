// An assessor: gives its own best answer (optional: absent, it endorses the draft) and decides
// whether a question escalates to the owner, given the request and the draft. This one never
// answers on its own. The core fails closed: anything but a valid `escalate: false` escalates.
// This one escalates when the question names a listed word, or the draft is not confident.
//   assessor: { name: words, plugin: keyword-assessor, options: { words: [delete, deploy, money] } }
import type { PluginDefinition } from 'job-hopper/plugin';

export default {
  id: 'keyword-assessor',
  role: 'assessor',
  describe: 'Escalates when the question names a listed word, or the draft is not confident',
  options: (z) => z.object({ words: z.array(z.string()).default(['delete', 'deploy', 'password']) }),
  async detect() { return { status: 'available' }; },
  create(ctx, options) {
    return {
      name: ctx.instanceName,
      async assess(req, draft) {
        const text = req.question.text.toLowerCase();
        const hit = options.words.find((w) => text.includes(w.toLowerCase()));
        if (hit) return { escalate: true, reason: `the question mentions "${hit}"` };
        return draft.confident ? { escalate: false, reason: 'confident draft, no listed word' } : { escalate: true, reason: 'the draft is not confident' };
      },
    };
  },
} satisfies PluginDefinition<'assessor', { words: string[] }>; // the options type, so `words` is typed
