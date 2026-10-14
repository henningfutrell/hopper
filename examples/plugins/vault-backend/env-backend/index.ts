// A vault backend: where a vault secret's value is kept outside the hopper. The vault still decides who gets it; the
// backend only reads the value a reference points at, at each delivery. This one reads it from a runtime variable:
// the reference is the variable's name, with the prefix the options give.
//   vaultBackends: [ { name: runtime, plugin: env-backend, options: { prefix: 'BOX_' } } ]
// then in Settings → Vault: a secret kept in `runtime`, reference `DB_PASSWORD` (the runtime's BOX_DB_PASSWORD).
import type { PluginDefinition } from 'hopper/plugin';

export default {
  id: 'env-backend',
  role: 'vault-backend',
  describe: 'Reads vault secrets from runtime variables',
  options: (z) => z.object({ prefix: z.string().default('') }),
  async detect() { return { status: 'available' }; },
  create(ctx, options) {
    return {
      name: ctx.instanceName,
      check: (reference: string) => (/^[A-Z_][A-Z0-9_]*$/.test(reference) ? undefined : 'a reference is a variable name: capitals, digits and _'),
      async read(reference: string) {
        const value = ctx.env(`${options.prefix}${reference}`);
        if (value === undefined) throw new Error(`${ctx.secretName(`${options.prefix}${reference}`)} is not set`);
        return value;
      },
    };
  },
} satisfies PluginDefinition<'vault-backend'>;
