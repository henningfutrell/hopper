// The vault container's entry (issue #586, docs/deploy.md "Optional services"): `node src/vault/main.ts` in the hopper's
// image. Listens on every interface of its container, at HOPPER_VAULT_PORT (default 4791); the compose file publishes no
// port, so only the compose network reaches it.
import { logMask } from '../secrets/log-mask.ts';
import { launchKey } from '../secrets/master-key.ts';
import { kmsOf } from './kms.ts';
import { startVaultServer } from './server.ts';
import { VAULT_PORT } from './wire.ts';

// Every log line goes through the secret mask, the master key and its previous keys held by value (issue #685).
for (const s of [process.stdout, process.stderr]) logMask.cover(s);
const key = launchKey(process.env);
if (key) logMask.hold(key.key, ...key.previous);
const port = Number(process.env.HOPPER_VAULT_PORT || VAULT_PORT);
const server = await startVaultServer({ env: process.env, host: '0.0.0.0', port });
const kms = kmsOf(process.env);
console.log(`hopper vault: listening on port ${port}; key provider: ${kms ? `the KMS at ${kms.url}` : 'the master key'}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void server.stop().then(() => process.exit(0)); });
}
