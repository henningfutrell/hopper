// A router: advises admission and order for each job. This one admits every job, as is.
// Copy the directory into ~/.config/hopper/plugins/, then pick it in the UI (Plugins → Router) and
// set its option `note` (for example `open door`).
import type { PluginDefinition } from 'hopper/plugin'; // type-only: erased when Node runs it

export default {
  id: 'proceed-all',
  role: 'router',
  describe: 'Admits every job as proceed_full',
  // Options are a zod schema built from the `z` the core passes in. Give every option a default.
  options: (z) => z.object({ note: z.string().default('admit everything') }),
  // Cheap check that it can run here. Never a paid call; never runs a GUI program.
  async detect() { return { status: 'available' }; },
  create(ctx, options) {
    return {
      name: ctx.instanceName, // the core names the instance after the plugins config anyway
      async advise() {
        return { action: 'proceed_full', reason: options.note, details: {}, source: 'proceed-all', at: ctx.clock.now().toISOString() };
      },
    };
  },
} satisfies PluginDefinition<'router'>;
