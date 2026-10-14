// hashicorp-vault (issue #585, design.md "Vault backends"): a vault secret kept in HashiCorp Vault's KV version 2 engine,
// read over Vault's HTTP API at each use with the token the runtime gives. A reference is `path#key`. No client library:
// one GET with a header is the whole of it, and the libraries for Node wrap that same call with more than they save.
import type { PluginDefinition, VaultBackend } from '../../sdk.ts';
import { credentialDetection, credentialOf } from '../credential.ts';

export interface HashicorpVaultOptions { address: string; mount: string; namespace: string; tokenEnv: string }

/** `path#key`: a path of segments (no `.` or `..` segment) and the key of the secret's data at that path. */
const REFERENCE = /^(?!.*(?:^|\/)\.{1,2}(?:\/|#))[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*#[^#\s]+$/;
const TIMEOUT_MS = 10_000;

const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

function createBackend(rt: Parameters<typeof credentialOf>[0], o: HashicorpVaultOptions, name: string): VaultBackend {
  const base = o.address.replace(/\/+$/, '');
  return {
    name,
    check: (reference) => (REFERENCE.test(reference) ? undefined : 'a HashiCorp Vault reference is path#key: the secret\'s path in the KV engine, then # and the key'),
    async read(reference) {
      const [path, key] = reference.split('#') as [string, string];
      const token = credentialOf(rt, o.tokenEnv);
      let res: Response;
      try {
        res = await fetch(`${base}/v1/${encodeURIComponent(o.mount)}/data/${encodePath(path)}`, {
          headers: { 'x-vault-token': token, ...(o.namespace ? { 'x-vault-namespace': o.namespace } : {}) },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        throw new Error(`HashiCorp Vault at ${base} cannot be reached: ${(e as Error).message}`, { cause: e });
      }
      if (res.status === 404) throw new Error(`no secret at ${path} in ${o.mount}`);
      if (res.status === 403) throw new Error(`HashiCorp Vault refused the token for ${path} (403): it may not read it, or it expired`);
      if (!res.ok) throw new Error(`HashiCorp Vault answered ${res.status} for ${path}`);
      const data = ((await res.json()) as { data?: { data?: Record<string, unknown> } }).data?.data ?? {};
      const value = data[key];
      if (value === undefined) throw new Error(`${path} has no key ${key}`);
      if (typeof value !== 'string') throw new Error(`${path}#${key} is not text`);
      return value;
    },
  };
}

const plugin: PluginDefinition<'vault-backend', HashicorpVaultOptions> = {
  id: 'hashicorp-vault',
  role: 'vault-backend',
  describe: 'Keeps vault secrets in HashiCorp Vault (KV version 2), read at each use with a token from the runtime',
  options: (z) => z.strictObject({
    // Where the token is sent: a UI session must not redirect it.
    address: z.string().url().default('http://vault:8200')
      .meta({ commandBearing: true, description: 'the Vault server\'s address; the default is the optional `vault` service of compose.yaml' }),
    mount: z.string().regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/).default('secret').meta({ description: 'the path the KV version 2 engine is mounted at' }),
    namespace: z.string().default('').meta({ description: 'the Vault namespace (Vault Enterprise, HCP Vault); empty: none' }),
    tokenEnv: z.string().min(1).default('VAULT_TOKEN')
      .meta({ commandBearing: true, description: 'runtime secret holding the Vault token: the variable, or the file <name>_FILE names' }),
  }),
  detect: async (sys, o) => credentialDetection(sys, o.tokenEnv, 'a Vault token that may read the secrets'),
  create: (ctx, o) => createBackend(ctx, o, ctx.instanceName),
};

export default plugin;
