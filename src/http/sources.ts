// GET /api/sources: every configured job source and its sync status (design.md "Job sources").
import type { FastifyInstance } from 'fastify';
import type { SourceRegistry } from '../domain/ports.ts';

export function sourceRoutes(app: FastifyInstance, o: { sources: SourceRegistry }): void {
  app.get('/api/sources', async () => ({ sources: o.sources.statuses() }));
}
