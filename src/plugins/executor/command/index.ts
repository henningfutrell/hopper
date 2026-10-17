// command: runs a job's body as a shell script on its lane's machine (issue #58, design.md
// "Container targets") — this machine, an ssh target, or, on a container target, a one-shot sandbox box
// of its own that the sandbox module starts and burns (issue #865). For a machine that runs no agent.
// Not in the built-in instances: the plugins config names it to use it.
import { join } from 'node:path';
import { createCommandExecutor } from '../../../executors/index.ts';
import { hopperSshAuth } from '../../../executors/ssh.ts';
import type { PluginDefinition } from '../../sdk.ts';

export interface CommandOptions { timeoutMs: number; sshBin: string }

const command: PluginDefinition<'executor', CommandOptions> = {
  id: 'command',
  role: 'executor',
  describe: 'Runs the job\'s body as a shell command on its machine (here, over ssh, or in a sandbox box of a container target) and returns its output',
  options: (z) => z.object({
    timeoutMs: z.number().int().positive().default(600000).meta({ description: 'how long one command may run' }),
    sshBin: z.string().min(1).default('ssh').meta({ commandBearing: true, description: 'the ssh client, for ssh targets' }),
  }),
  async detect() { return { status: 'available' }; },
  create: (ctx, o) => createCommandExecutor({
    name: ctx.instanceName, timeoutMs: o.timeoutMs, sshBin: o.sshBin, sshControlDir: join(ctx.dataDir, 'ssh'),
    sshAuth: () => hopperSshAuth({ env: ctx.env, dataDir: ctx.dataDir }), userEnv: ctx.userEnv,
    ...(ctx.boxes ? { boxes: ctx.boxes } : {}),
  }),
};

export default command;
