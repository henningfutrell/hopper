// newest-first: the job queued last runs first, whatever its priority (createdAt desc, then id).
import type { PluginDefinition } from '../../sdk.ts';

const newestFirst: PluginDefinition<'queue-sorter', Record<string, never>> = {
  id: 'newest-first',
  role: 'queue-sorter',
  describe: 'Newest job first, whatever its priority',
  async detect() { return { status: 'available' }; },
  create(ctx) {
    return {
      name: ctx.instanceName,
      sort: (entries) => [...entries].sort((a, b) => b.job.createdAt.localeCompare(a.job.createdAt) || a.job.id.localeCompare(b.job.id)).map((e) => e.job.id),
    };
  },
};

export default newestFirst;
