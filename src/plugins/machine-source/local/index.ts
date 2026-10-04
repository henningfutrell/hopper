// local: this laptop as the one machine (glossary "Machine"), named after the instance (`local`:
// lanes are stored under it). `lanes` is the lane count — a lane has no options of its own.
// `executors`, when given, narrows what runs here (issue #58: a `command` job goes to its target only).
import { createLocalMachineSource } from '../../../machines/index.ts';
import type { PluginDefinition } from '../../sdk.ts';

export interface LocalOptions { lanes: number; executors?: string[] }

const local: PluginDefinition<'machine-source', LocalOptions> = {
  id: 'local',
  role: 'machine-source',
  describe: 'This machine, running every registered executor (or the `executors` named) on up to `lanes` lanes at once',
  options: (z) => z.object({
    lanes: z.number().int().min(0).default(4).meta({ description: 'concurrent jobs on this machine' }),
    executors: z.array(z.string().min(1)).optional().meta({ description: 'executor instances that run on this machine; absent: every registered one' }),
  }),
  async detect() { return { status: 'available' }; },
  create: (ctx, o) => createLocalMachineSource({
    id: ctx.instanceName, maxLanes: o.lanes,
    executors: o.executors ? () => ctx.executors().filter((x) => o.executors!.includes(x)) : ctx.executors,
  }),
};

export default local;
