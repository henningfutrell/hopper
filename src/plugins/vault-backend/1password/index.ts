// 1password (issue #585, design.md "Vault backends"): a vault secret kept in 1Password, read at each use through
// 1Password's own SDK (`@1password/sdk`) with a service account token from the runtime. A reference is 1Password's
// secret reference, `op://vault/item/field` (or `op://vault/item/section/field`). The SDK is loaded at the first read,
// so a hopper that names no 1Password backend never loads it.
import type { PluginDefinition, VaultBackend } from '../../sdk.ts';
import { clientPerCredential, credentialDetection, credentialOf } from '../credential.ts';

export interface OnePasswordOptions { tokenEnv: string }

/** What the backend needs of 1Password: a client that resolves a secret reference. */
export interface OnePasswordClient { resolve(reference: string): Promise<string> }

const REFERENCE = /^op:\/\/[^/\s]+\/[^/\s]+(\/[^/\s]+)?\/[^/\s]+$/;

/** The SDK's client, made with a service account token. */
async function connect(token: string): Promise<OnePasswordClient> {
  const { createClient } = await import('@1password/sdk');
  const client = await createClient({ auth: token, integrationName: 'hopper', integrationVersion: '1' });
  return { resolve: (reference) => client.secrets.resolve(reference) };
}

export function onePasswordPlugin(seam: { connect?: (token: string) => Promise<OnePasswordClient> } = {}): PluginDefinition<'vault-backend', OnePasswordOptions> {
  return {
    id: '1password',
    role: 'vault-backend',
    describe: 'Keeps vault secrets in 1Password, read at each use with a service account token from the runtime',
    options: (z) => z.strictObject({
      tokenEnv: z.string().min(1).default('OP_SERVICE_ACCOUNT_TOKEN')
        .meta({ commandBearing: true, description: 'runtime secret holding the 1Password service account token: the variable, or the file <name>_FILE names' }),
    }),
    detect: async (sys, o) => credentialDetection(sys, o.tokenEnv, 'a 1Password service account token that may read the vaults'),
    create(ctx, o): VaultBackend {
      const client = clientPerCredential(seam.connect ?? connect);
      return {
        name: ctx.instanceName,
        check: (reference) => (REFERENCE.test(reference) ? undefined : 'a 1Password reference is op://vault/item/field, as Copy Secret Reference gives it'),
        async read(reference) {
          const credential = credentialOf(ctx, o.tokenEnv);
          try {
            return await (await client(credential)).resolve(reference);
          } catch (e) {
            throw new Error(`1Password cannot resolve ${reference}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
          }
        },
      };
    },
  };
}

export default onePasswordPlugin();
