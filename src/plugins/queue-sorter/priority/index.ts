// priority: the decider's own order — effective priority desc, createdAt asc, id. The default queue
// sorter, and the one that answers when the configured sorter cannot (design.md "Queue sorter").
import type { PluginDefinition, QueueEntry } from '../../sdk.ts';

export const byPriority = (a: QueueEntry, b: QueueEntry): number =>
  b.effectivePriority - a.effectivePriority || a.job.createdAt.localeCompare(b.job.createdAt) || a.job.id.localeCompare(b.job.id);

const priority: PluginDefinition<'queue-sorter', Record<string, never>> = {
  id: 'priority',
  role: 'queue-sorter',
  describe: 'Highest effective priority first, then oldest, then job id (the decider\'s own order)',
  async detect() { return { status: 'available' }; },
  create(ctx) {
    return { name: ctx.instanceName, sort: (entries) => [...entries].sort(byPriority).map((e) => e.job.id) };
  },
};

export default priority;
