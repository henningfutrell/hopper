// client: a client target, a machine running the hopper client that dials in to this hopper; herdr calls
// go down its link, signed with the client token both ends derive from their link keys (design.md
// "Client targets", "Joining a machine", issues #59, #308; a plugin since issue #74). `key` is its
// machine key — the public half of its link key, recorded when it joined: who it is, never a secret.
import type { ClientMachine } from '../../../domain/types.ts';
import type { PluginDefinition } from '../../sdk.ts';
import { attachedBase, attachedShape, diskLowShape, reach, sweepShape, workTreeOption, type AttachedOptions } from '../attached.ts';

export interface ClientOptions extends AttachedOptions { key: string; template?: string; container?: string }

export const clientMachine = (name: string, o: ClientOptions): ClientMachine => ({
  ...attachedBase(name, o), client: { key: o.key, ...(o.template ? { template: o.template } : {}), ...(o.container ? { container: o.container } : {}) },
});

const client: PluginDefinition<'machine-source', ClientOptions> = {
  id: 'client',
  role: 'machine-source',
  describe: 'A client target: a machine running the hopper client, dialled in to this hopper (added with Add machine)',
  options: (z) => z.strictObject({
    key: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'key must be a machine key: the public half of its link key, 43 base64url characters')
      .meta({ commandBearing: true, description: 'its machine key, recorded when it joined: the public half of its link key — the one machine its jobs go to' }),
    template: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/).optional()
      .meta({ commandBearing: true, description: 'the template it joined as (issue #558): its join line named it; what of the vault its jobs may ask for' }),
    container: z.string().regex(/^hopper-sandbox-[a-z0-9][a-z0-9._-]{0,80}$/).optional()
      .meta({ commandBearing: true, description: 'the sandbox box the hopper started for it (issue #603): removing the machine stops and removes that box' }),
    ...attachedShape(z, ['herdr-claude']),
    workTree: workTreeOption(z),
    ...diskLowShape(z),
    ...sweepShape(z),
  }),
  async detect() { return { status: 'available' }; },
  create: (ctx, o) => reach(ctx, clientMachine(ctx.instanceName, o)),
};

export default client;
