// bitwarden (issue #585, design.md "Vault backends"): a vault secret kept in Bitwarden Secrets Manager, read at each use
// through Bitwarden's own SDK (`@bitwarden/sdk-napi`) with a machine account's access token from the runtime. A
// reference is the secret's id. The SDK is loaded at the first read, so a hopper that names no Bitwarden backend never
// loads it.
import type { PluginDefinition, VaultBackend } from '../../sdk.ts';
import { clientPerCredential, credentialDetection, credentialOf } from '../credential.ts';

export interface BitwardenOptions { apiUrl: string; identityUrl: string; tokenEnv: string }

/** What the backend needs of Bitwarden: a signed-in client that reads a secret's value by its id. */
export interface BitwardenClient { get(id: string): Promise<string> }

/** Where Bitwarden's SDK has a build (its optional packages): elsewhere it cannot load. */
const BUILDS = ['linux-x64', 'darwin-x64', 'darwin-arm64', 'win32-x64'];
const REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The SDK's client, signed in with a machine account's access token. No state file: nothing is written to disk. */
async function connect(token: string, urls: { apiUrl: string; identityUrl: string }): Promise<BitwardenClient> {
  // A CommonJS module: its exports are its default. Its LogLevel is a const enum, gone at run time: 4 is Error.
  const sdk = (await import('@bitwarden/sdk-napi')).default;
  const client = new sdk.BitwardenClient({ ...urls, userAgent: 'hopper', deviceType: sdk.DeviceType.SDK }, 4);
  await client.auth().loginAccessToken(token);
  return { get: async (id) => (await client.secrets().get(id)).value };
}

export function bitwardenPlugin(seam: { connect?: (token: string, urls: { apiUrl: string; identityUrl: string }) => Promise<BitwardenClient>; platform?: string } = {}): PluginDefinition<'vault-backend', BitwardenOptions> {
  const platform = seam.platform ?? `${process.platform}-${process.arch}`;
  return {
    id: 'bitwarden',
    role: 'vault-backend',
    describe: 'Keeps vault secrets in Bitwarden Secrets Manager, read at each use with a machine account\'s access token from the runtime',
    options: (z) => z.strictObject({
      // Where the access token is sent: a UI session must not redirect it.
      apiUrl: z.string().url().default('https://api.bitwarden.com')
        .meta({ commandBearing: true, description: 'the Bitwarden API server (https://api.bitwarden.eu for the EU cloud, or your own)' }),
      identityUrl: z.string().url().default('https://identity.bitwarden.com')
        .meta({ commandBearing: true, description: 'the Bitwarden identity server (https://identity.bitwarden.eu for the EU cloud, or your own)' }),
      tokenEnv: z.string().min(1).default('BWS_ACCESS_TOKEN')
        .meta({ commandBearing: true, description: 'runtime secret holding the machine account\'s access token: the variable, or the file <name>_FILE names' }),
    }),
    detect: async (sys, o) => (BUILDS.includes(platform)
      ? credentialDetection(sys, o.tokenEnv, 'a Bitwarden machine account access token that may read the secrets')
      : { status: 'unavailable', reason: `Bitwarden's SDK has no build for ${platform}` }),
    create(ctx, o): VaultBackend {
      const client = clientPerCredential((token) => (seam.connect ?? connect)(token, { apiUrl: o.apiUrl, identityUrl: o.identityUrl }));
      return {
        name: ctx.instanceName,
        check: (reference) => (REFERENCE.test(reference) ? undefined : 'a Bitwarden reference is the secret\'s id, as Secrets Manager shows it'),
        async read(reference) {
          const credential = credentialOf(ctx, o.tokenEnv);
          try {
            return await (await client(credential)).get(reference);
          } catch (e) {
            throw new Error(`Bitwarden cannot read ${reference}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
          }
        },
      };
    },
  };
}

export default bitwardenPlugin();
