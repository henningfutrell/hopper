// client: a client target, a machine running the hopper client that dials this one; herdr calls go
// through its tunnel, signed with its client token (design.md "Client targets", issue #59; a plugin
// since issue #74). Named after the instance, which names its tunnel's socket. `tokenEnv` — the
// variable the client token is in — is command-bearing.
import type { ClientMachine } from '../../../domain/types.ts';
import type { PluginDefinition } from '../../sdk.ts';
import { attachedBase, attachedShape, reach, type AttachedOptions } from '../attached.ts';

export interface ClientOptions extends AttachedOptions { tokenEnv: string }

const CLIENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Throws when the name cannot name its tunnel's socket. */
export function clientMachine(name: string, o: ClientOptions): ClientMachine {
  if (!CLIENT_NAME.test(name)) throw new Error(`${name}: a client target name is letters, digits, _ and - (it names its tunnel's socket)`);
  return { ...attachedBase(name, o), client: { tokenEnv: o.tokenEnv } };
}

const client: PluginDefinition<'machine-source', ClientOptions> = {
  id: 'client',
  role: 'machine-source',
  describe: 'A client target: a machine running the hopper client, reached through its tunnel',
  options: (z) => z.strictObject({
    tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'tokenEnv must name an environment variable (A-Z, 0-9, _)')
      .meta({ commandBearing: true, description: 'the variable (or its _FILE) the client token is in, in the hopper\'s runtime' }),
    ...attachedShape(z, ['herdr-claude']),
  }),
  async detect() { return { status: 'available' }; },
  create: (ctx, o) => reach(ctx, clientMachine(ctx.instanceName, o)),
};

export default client;
