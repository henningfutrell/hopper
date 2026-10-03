// pass-through: every job proceeds. The router the host falls back to when the configured one
// cannot run (its advice is then marked `source: fallback`).
import type { PluginDefinition } from '../../sdk.ts';

const passThrough: PluginDefinition<'router', Record<string, never>> = {
  id: 'pass-through',
  role: 'router',
  describe: 'Admits every job as proceed_full; no classification',
  async detect() {
    return { status: 'available' };
  },
  create(ctx) {
    return {
      name: 'pass-through',
      async advise() {
        return { action: 'proceed_full', reason: 'pass-through: every job proceeds', details: {}, source: 'pass-through', at: ctx.clock.now().toISOString() };
      },
    };
  },
};

export default passThrough;
