// hopper.io's composition root (issue #463): config from the runtime → store (migrated) → server. `npm run cloud`.
// Not the daemon: the daemon's image does not carry cloud/, and nothing in src/ imports it.
import { cloudConfig } from './config.ts';
import { cloudServer } from './server.ts';
import { openCloudStore } from './store.ts';

const config = cloudConfig(process.env);
const store = await openCloudStore(config.databaseUrl);
const server = await cloudServer({ config, store });
await server.listen({ host: config.host, port: config.port });
console.log(`hopper.io listening on ${config.host}:${config.port}, public at ${config.publicUrl}`);

const stop = async () => {
  await server.close();
  await store.close();
  process.exit(0);
};
process.once('SIGTERM', () => void stop());
process.once('SIGINT', () => void stop());
