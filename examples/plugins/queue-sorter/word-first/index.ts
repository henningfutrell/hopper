// A queue sorter: orders the waiting jobs once per Decision. This one runs jobs whose goal
// mentions a word first, then the rest by effective priority. Copy the directory into
// ~/.config/hopper/plugins/, then name it in plugins.yaml:
//   queueSorter: { name: urgent, plugin: word-first, options: { word: urgent } }
import type { PluginDefinition, QueueEntry } from 'hopper/plugin'; // type-only: erased when Node runs it

export default {
  id: 'word-first',
  role: 'queue-sorter',
  describe: 'Jobs whose goal mentions a word first, then by effective priority',
  options: (z) => z.object({ word: z.string().default('urgent') }),
  async detect() { return { status: 'available' }; },
  create(ctx, options) {
    const marked = (e: QueueEntry) => (e.job.spec.goal ?? '').toLowerCase().includes(options.word.toLowerCase());
    return {
      name: ctx.instanceName,
      // Synchronous. Return job ids; ids left out run after these, in the decider's own order.
      // Throwing or returning anything but distinct waiting job ids falls back to `priority`.
      sort: (entries) => [...entries]
        .sort((a, b) => Number(marked(b)) - Number(marked(a)) || b.effectivePriority - a.effectivePriority)
        .map((e) => e.job.id),
    };
  },
} satisfies PluginDefinition<'queue-sorter', { word: string }>;
