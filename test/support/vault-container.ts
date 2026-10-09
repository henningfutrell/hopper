// The vault in a container of its own (issue #586), as a test runs it: the vault server the compose file's `vault`
// service starts, here on loopback over the test's database, with the environment that service gets.
import { startVaultServer } from '../../src/vault/server.ts';
import { databaseUrlFor } from './database.ts';

export const VAULT_KEY = 'vault-preshared-key-0123456789abcdef0123456789abcdef';

/** The vault server over the database of `dbPath`: its URL, and stop. `env` over its database URL and the preshared key. */
export function startVaultContainer(dbPath: string, env: Record<string, string> = {}): Promise<{ url: string; stop(): Promise<void> }> {
  return startVaultServer({ env: { HOPPER_DATABASE_URL: databaseUrlFor(dbPath), HOPPER_VAULT_KEY: VAULT_KEY, ...env }, host: '127.0.0.1', port: 0 });
}
