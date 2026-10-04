// oldest-first: the job queued first runs first, whatever its priority (createdAt asc, then id).
import type { PluginDefinition } from '../../sdk.ts';

const oldestFirst: PluginDefinition<'queue-sorter', Record<string, never>> = {
  id: 'oldest-first',
  role: 'queue-sorter',
  describe: 'Oldest job first, whatever its priority',
  async detect() { return { status: 'available' }; },
  create(ctx) {
    return {
      name: ctx.instanceName,
      sort: (entries) => [...entries].sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt) || a.job.id.localeCompare(b.job.id)).map((e) => e.job.id),
    };
  },
};

export default oldestFirst;
