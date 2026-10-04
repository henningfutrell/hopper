// A notifier: tells something outside about events. Started once with the event feed, stopped at
// shutdown. This one logs the events of the listed types.
//   notifiers: [ { name: log, plugin: log-events, options: { types: [question.escalated, job.failed] } } ]
import type { PluginDefinition } from 'job-hopper/plugin';

export default {
  id: 'log-events',
  role: 'notifier',
  describe: 'Logs every event of the listed types',
  options: (z) => z.object({ types: z.array(z.string()).default(['question.escalated']) }),
  async detect() { return { status: 'available' }; },
  create(ctx, options) {
    let unsubscribe: (() => void) | undefined;
    return {
      name: ctx.instanceName,
      start(events) {
        unsubscribe = events.subscribe((e) => {
          if (!options.types.includes(e.type)) return;
          // Listeners run inside the append: never block here. Real I/O goes off it (setImmediate).
          const title = e.jobId ? events.job(e.jobId)?.source?.title : undefined;
          ctx.logger.info(`${ctx.instanceName}: ${e.type}${e.jobId ? ` job ${e.jobId}` : ''}${title ? ` (${title})` : ''}`);
        });
      },
      async stop() { unsubscribe?.(); },
    };
  },
} satisfies PluginDefinition<'notifier'>;
