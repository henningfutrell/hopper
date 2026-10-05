// A usage source: budget readings the decider scales lanes by (past the soft limit fewer lanes,
// at the hard limit none). This one reports one fixed reading.
//   usageSources: [ { name: budget, plugin: fixed-usage, options: { used: 30, limit: 100 } } ]
import type { PluginDefinition } from 'hopper/plugin';

export default {
  id: 'fixed-usage',
  role: 'usage-source',
  describe: 'Reports one fixed usage reading',
  options: (z) => z.object({ used: z.number().min(0).default(0), limit: z.number().positive().default(100), unit: z.string().default('%') }),
  async detect() { return { status: 'available' }; },
  create(ctx, options) {
    return {
      name: ctx.instanceName,
      async poll() {
        return [{ source: ctx.instanceName, used: options.used, limit: options.limit, unit: options.unit, at: ctx.clock.now().toISOString() }];
      },
    };
  },
} satisfies PluginDefinition<'usage-source'>;
