// Self-update, read side (design.md "Self-update"): what is installed, what is newer, how an apply stands.
import type { FastifyInstance } from 'fastify';
import type { Updater } from '../domain/ports.ts';

export function updateRoutes(app: FastifyInstance, o: { updater: Updater }): void {
  app.get('/api/update', async () => o.updater.status());
}
