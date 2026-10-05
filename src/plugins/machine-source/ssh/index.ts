// ssh: an attached machine reached over ssh, running jobs in its own herdr session (design.md
// "Attached machines", "Target authentication"; issue #74), or with `herdr: false` none: then only
// executors that need no herdr run there (issue #142). Named after the instance. `ssh`, `herdr`, `session`,
// `herdrBin` and the pinned `hostKey` are command-bearing: the Machines view writes them when it
// attaches the machine, the operator by hand.
import type { SshMachine } from '../../../domain/types.ts';
import { HOST_KEY } from '../../../executors/ssh.ts';
import type { PluginDefinition } from '../../sdk.ts';
import { attachedBase, attachedShape, reach, type AttachedOptions } from '../attached.ts';

export interface SshOptions extends AttachedOptions { ssh: string; herdr: boolean; session: string; herdrBin: string; hostKey?: string }

export const sshMachine = (name: string, o: SshOptions): SshMachine => ({
  ...attachedBase(name, o), ssh: o.ssh, herdr: o.herdr, session: o.session, herdrBin: o.herdrBin, ...(o.hostKey !== undefined ? { hostKey: o.hostKey } : {}),
});

const ssh: PluginDefinition<'machine-source', SshOptions> = {
  id: 'ssh',
  role: 'machine-source',
  describe: 'A machine reached over ssh, running jobs in its own herdr session or, without herdr, Cursor and commands',
  options: (z) => z.strictObject({
    ssh: z.string().min(1).refine((s) => !s.startsWith('-'), 'ssh must be a destination, not an option')
      .meta({ commandBearing: true, description: 'the ssh destination: a ~/.ssh/config alias or user@host' }),
    ...attachedShape(z, ['herdr-claude']),
    herdr: z.boolean().default(true)
      .meta({ commandBearing: true, description: 'it runs herdr; false: probed over ssh alone, and herdr-claude does not run there' }),
    session: z.string().min(1).refine((s) => s !== 'default', 'must not be the default herdr session').default('hopper')
      .meta({ commandBearing: true, description: 'its herdr session' }),
    herdrBin: z.string().min(1).default('herdr').meta({ commandBearing: true, description: 'herdr there, as its login shell finds it' }),
    hostKey: z.string().regex(HOST_KEY, 'hostKey must be a public host key, `<type> <base64>`, as ssh_host_*_key.pub holds it (comment dropped)').optional()
      .meta({ commandBearing: true, description: 'its pinned host key: the only one the hopper accepts; absent, it does not connect' }),
  }),
  async detect() { return { status: 'available' }; },
  create: (ctx, o) => reach(ctx, sshMachine(ctx.instanceName, o)),
};

export default ssh;
