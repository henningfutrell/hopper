// local: this laptop as the one machine (glossary "Machine"), named after the instance (`local`:
// lanes are stored under it). `lanes` is the lane count — a lane has no options of its own.
import { createLocalMachineSource } from '../../../machines/index.ts';
import type { PluginDefinition } from '../../sdk.ts';

export interface LocalOptions { lanes: number }

const local: PluginDefinition<'machine-source', LocalOptions> = {
  id: 'local',
  role: 'machine-source',
  describe: 'This machine, running every registered executor on up to `lanes` lanes at once',
  options: (z) => z.object({ lanes: z.number().int().min(0).default(4).meta({ description: 'concurrent jobs on this machine' }) }),
  async detect() { return { status: 'available' }; },
  create: (ctx, o) => createLocalMachineSource({ id: ctx.instanceName, maxLanes: o.lanes, executors: ctx.executors }),
};

export default local;
