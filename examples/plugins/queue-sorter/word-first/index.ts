// A queue sorter: orders the waiting jobs once per Decision. This one runs jobs whose goal
// mentions a word first, then the rest by effective priority; as the queue gate's pre-sort, it
// rejects jobs whose goal mentions a word to avoid (`avoid`, none by default). Copy the directory into
// ~/.config/hopper/plugins/, then pick it in the UI (Plugins → Queue sorter) and set its option
// `word` (for example `urgent`).
import type { PluginDefinition, QueueEntry } from 'hopper/plugin'; // type-only: erased when Node runs it

export default {
  id: 'word-first',
  role: 'queue-sorter',
  describe: 'Jobs whose goal mentions a word first, then by effective priority',
  options: (z) => z.object({ word: z.string().default('urgent'), avoid: z.string().nullable().default(null) }),
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
      // Optional: the jobs not yet accepted at the queue gate that this pre-sort turns away, and why.
      reject: (entries) => {
        const avoid = options.avoid?.toLowerCase();
        return avoid ? entries.filter((e) => (e.job.spec.goal ?? '').toLowerCase().includes(avoid))
          .map((e) => ({ jobId: e.job.id, reason: `the goal mentions ${options.avoid}` })) : [];
      },
    };
  },
} satisfies PluginDefinition<'queue-sorter', { word: string; avoid: string | null }>;
