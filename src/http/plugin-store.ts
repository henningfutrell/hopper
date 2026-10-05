// The plugin store, read side (design.md "Plugin store"): its catalogue and the store installs.
import type { FastifyInstance } from 'fastify';
import type { PluginStoreView } from '../domain/ports.ts';

export function pluginStoreRoutes(app: FastifyInstance, o: { pluginStore: PluginStoreView }): void {
  app.get('/api/plugin-store', async () => o.pluginStore.report());
}
