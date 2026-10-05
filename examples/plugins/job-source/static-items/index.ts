// A job source: where the hopper pulls jobs from. The instance name keys its jobs and sync state,
// so the source must call itself `ctx.instanceName`. This one offers the items in its options.
//   jobSources: [ { name: chores, plugin: static-items, options: { items: [ { key: chore-1, title: Tidy, prompt: Tidy the repo } ] } } ]
import type { PluginDefinition, SourceItem } from 'hopper/plugin';

/** The options type: with it, `options` is typed in `create` (without it, `any`). */
interface StaticItemsOptions { items: { key: string; title: string; prompt: string }[]; executor: string; cwd: string; pollSeconds: number }

export default {
  id: 'static-items',
  role: 'job-source',
  describe: 'Offers a fixed list of items from its options',
  options: (z) => z.object({
    items: z.array(z.object({ key: z.string(), title: z.string(), prompt: z.string() })).default([]),
    executor: z.string().default('herdr-claude'),
    cwd: z.string().default('/tmp'),
    pollSeconds: z.number().int().min(1).default(60),
  }),
  async detect() { return { status: 'available' }; },
  create(ctx, options) {
    const items: SourceItem[] = options.items.map((i) => ({
      key: `${ctx.instanceName}:${i.key}`, url: '', title: i.title, body: i.prompt, prompt: i.prompt, env: {},
      author: 'static-items', priority: 50, priorityReason: 'default', cwd: options.cwd, labels: [], executor: options.executor,
    }));
    return {
      pollMs: options.pollSeconds * 1000,
      source: {
        name: ctx.instanceName,
        kind: 'static-items',
        describe: () => ({ items: items.length }),
        // Offer only items that have no job yet (ctx.knownKeys asks the store).
        async discover() { const known = ctx.knownKeys(items.map((i) => i.key)); return items.filter((i) => !known.has(i.key)); },
        async check() { return []; }, // no cancellations from here
        async report(r) { return { lastReport: r.kind }; }, // the job's new sourceState.source
      },
    };
  },
} satisfies PluginDefinition<'job-source', StaticItemsOptions>;
