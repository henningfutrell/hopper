// The plugin definition every print-mode agent executor shares (design.md "Print-mode agent executors"):
// cursor-agent, codex, opencode and omp differ only in their CLI, its default arguments and what they say
// about it. Each is opt-in, not in the built-in instances: the plugins config names it to use it, and an
// agent box switches on the one it runs (scripts/agent-boxes.sh). The agent signs in on each machine it
// runs on: the hopper holds no credential of theirs.
import { join } from 'node:path';
import { JOBS_DIR } from '../../domain/types.ts';
import { createPrintAgentExecutor, type PrintAgent } from '../../executors/index.ts';
import { hopperSshAuth } from '../../executors/ssh.ts';
import type { PluginDefinition } from '../sdk.ts';

export interface PrintAgentOptions { bin: string; args: string[]; cwd: string; sshBin: string }

export function printAgentPlugin(p: { id: PrintAgent; describe: string; bin: string; binIs: string; args: string[]; argsAre: string }): PluginDefinition<'executor', PrintAgentOptions> {
  return {
    id: p.id,
    role: 'executor',
    describe: p.describe,
    options: (z) => z.object({
      bin: z.string().min(1).default(p.bin).meta({ commandBearing: true, description: p.binIs }),
      args: z.array(z.string()).default(p.args).meta({ commandBearing: true, description: p.argsAre }),
      cwd: z.string().min(1).default(JOBS_DIR)
        .meta({ commandBearing: true, description: 'working directory of a job whose payload names none' }),
      sshBin: z.string().min(1).default('ssh').meta({ commandBearing: true, description: 'the ssh client, for ssh targets' }),
    }),
    async detect(sys, o) {
      const here = await sys.which(o.bin);
      return { status: 'available', detail: here ?? `${o.bin} is not on this machine: its jobs run only on machines that have it` };
    },
    create: (ctx, o) => createPrintAgentExecutor({
      agent: p.id, name: ctx.instanceName, bin: o.bin, args: o.args, defaultCwd: o.cwd, sshBin: o.sshBin, sshControlDir: join(ctx.dataDir, 'ssh'),
      sshAuth: () => hopperSshAuth({ env: ctx.env, dataDir: ctx.dataDir }), userEnv: ctx.userEnv,
    }),
  };
}
