// A machine source: the hosts that can run jobs. The machine id is the instance name (lanes are
// stored under it). This one is one machine with a fixed lane count.
//   machines: { name: local, plugin: fixed-machine, options: { lanes: 2 } }
import type { PluginDefinition } from 'hopper/plugin';

export default {
  id: 'fixed-machine',
  role: 'machine-source',
  describe: 'One machine running every registered executor on a fixed number of lanes',
  options: (z) => z.object({ lanes: z.number().int().min(0).default(1) }),
  async detect() { return { status: 'available' }; },
  create(ctx, options) {
    return {
      // Asked on every engine tick: keep it cheap.
      async list() {
        return [{ id: ctx.instanceName, label: ctx.instanceName, maxLanes: options.lanes, online: true, executors: ctx.executors() }];
      },
    };
  },
} satisfies PluginDefinition<'machine-source'>;
