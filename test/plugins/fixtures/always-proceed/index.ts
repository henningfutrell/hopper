// The design's example custom plugin, verbatim in shape. Type-checked by `npm run typecheck`
// through the package self-reference `job-hopper/plugin`; loaded by the loader tests from a copy.
import type { PluginDefinition } from 'job-hopper/plugin'; // type-only, erased at runtime

export default {
  id: 'always-proceed',
  role: 'router',
  describe: 'Admits every job as proceed_full',
  options: (z) => z.object({ note: z.string().default('') }),
  async detect() { return { status: 'available' }; },
  create(ctx, options) {
    return {
      name: 'always-proceed',
      async advise() {
        return { action: 'proceed_full', reason: options.note || 'always', details: {}, source: 'always-proceed', at: ctx.clock.now().toISOString() };
      },
    };
  },
} satisfies PluginDefinition<'router'>;
