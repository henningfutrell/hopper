// cursor-agent: one job is Cursor's CLI agent in print mode, on the job's machine — this one or an ssh
// target — in the job's work tree (issue #142, design.md "Cursor executor"). A question resumes the
// same Cursor chat. Not in the built-in instances: plugins.yaml names it to use it. Cursor signs in
// on each machine it runs on (`cursor-agent login`, or CURSOR_API_KEY in that machine's environment):
// the hopper holds no Cursor credential.
import { join } from 'node:path';
import { createCursorExecutor } from '../../../executors/index.ts';
import { hopperSshAuth } from '../../../executors/ssh.ts';
import { expandHome } from '../../expand-home.ts';
import type { PluginDefinition } from '../../sdk.ts';

export interface CursorAgentOptions { bin: string; args: string[]; cwd: string; sshBin: string }

const cursorAgent: PluginDefinition<'executor', CursorAgentOptions> = {
  id: 'cursor-agent',
  role: 'executor',
  describe: "Cursor's agent (the Cursor CLI) on the job's machine, here or over ssh, one print-mode run per turn",
  options: (z) => z.object({
    bin: z.string().min(1).default('cursor-agent').meta({ commandBearing: true, description: "Cursor's CLI agent on the job's machine" }),
    args: z.array(z.string()).default(['--force', '--trust'])
      .meta({ commandBearing: true, description: "its own arguments: --force runs its tools without asking, --trust trusts the work tree" }),
    cwd: z.string().min(1).default('~').transform(expandHome)
      .meta({ commandBearing: true, description: 'working directory of a job whose payload names none' }),
    sshBin: z.string().min(1).default('ssh').meta({ commandBearing: true, description: 'the ssh client, for ssh targets' }),
  }),
  async detect(sys, o) {
    const here = await sys.which(o.bin);
    return { status: 'available', detail: here ?? `${o.bin} is not on this machine: its jobs run only on machines that have it` };
  },
  create: (ctx, o) => createCursorExecutor({
    name: ctx.instanceName, bin: o.bin, args: o.args, defaultCwd: o.cwd, sshBin: o.sshBin, sshControlDir: join(ctx.dataDir, 'ssh'),
    sshAuth: () => hopperSshAuth({ env: ctx.env, dataDir: ctx.dataDir }), userEnv: ctx.userEnv,
  }),
};

export default cursorAgent;
