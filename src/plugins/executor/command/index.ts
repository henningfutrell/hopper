// command: runs a job's body as a shell script on its lane's machine (issue #58, design.md
// "Container targets") — this machine, an ssh target, or a container target over docker exec. For a
// machine that runs no agent. Not in the built-in instances: the plugins config names it to use it.
import { join } from 'node:path';
import { createCommandExecutor } from '../../../executors/index.ts';
import { dockerHost } from '../../../executors/docker.ts';
import { hopperSshAuth } from '../../../executors/ssh.ts';
import type { PluginDefinition } from '../../sdk.ts';

export interface CommandOptions { timeoutMs: number; dockerBin: string; sshBin: string }

const command: PluginDefinition<'executor', CommandOptions> = {
  id: 'command',
  role: 'executor',
  describe: 'Runs the job\'s body as a shell command on its machine (here, over ssh, or docker exec into a container) and returns its output',
  options: (z) => z.object({
    timeoutMs: z.number().int().positive().default(600000).meta({ description: 'how long one command may run' }),
    dockerBin: z.string().min(1).default('docker').meta({ commandBearing: true, description: 'the docker CLI, for container targets' }),
    sshBin: z.string().min(1).default('ssh').meta({ commandBearing: true, description: 'the ssh client, for ssh targets' }),
  }),
  async detect() { return { status: 'available' }; },
  create: (ctx, o) => createCommandExecutor({
    name: ctx.instanceName, timeoutMs: o.timeoutMs, dockerBin: o.dockerBin, sshBin: o.sshBin, sshControlDir: join(ctx.dataDir, 'ssh'),
    sshAuth: () => hopperSshAuth({ env: ctx.env, dataDir: ctx.dataDir }),
    dockerHost: () => dockerHost(ctx.env), userEnv: ctx.userEnv,
  }),
};

export default command;
