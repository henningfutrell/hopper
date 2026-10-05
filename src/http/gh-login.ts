// gh login, read side (design.md "gh login", issue #138): the gh CLI's login, or the device code it waits on.
import type { FastifyInstance } from 'fastify';
import type { GhLogin } from '../domain/ports.ts';

export function ghLoginRoutes(app: FastifyInstance, o: { ghLogin: GhLogin }): void {
  app.get('/api/gh-login', async () => o.ghLogin.status());
}
