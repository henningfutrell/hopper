// An executor: runs one job on one lane. Jobs name the executor INSTANCE (Plugins), so:
//   executors: [ { name: echo, plugin: echo-executor, options: { prefix: "heard: " } } ]
// and a job source item with `executor: echo` runs here. This one finishes at once, echoing the prompt.
import type { PluginDefinition } from 'hopper/plugin';

export default {
  id: 'echo-executor',
  role: 'executor',
  describe: "Finishes every job at once with its prompt as the result",
  options: (z) => z.object({ prefix: z.string().default('') }),
  async detect() { return { status: 'available' }; },
  create(ctx, options) {
    return {
      name: ctx.instanceName,
      // Checked when a job is pulled: return an error string to fail the job before it runs.
      validate: (payload) => (typeof payload.prompt === 'string' ? null : 'payload.prompt must be a string'),
      // Must resolve, never reject: report a failure as { kind: 'failed', error }.
      async run(run) {
        run.progress(1, 'echoed');
        return { kind: 'finished', result: { echoed: `${options.prefix}${String(run.job.spec.payload.prompt)}` } };
      },
    };
  },
} satisfies PluginDefinition<'executor'>;
