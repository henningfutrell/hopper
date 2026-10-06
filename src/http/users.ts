// GET /api/users (issue #158, design.md "Users: one hopper, separate users"): who the users are — id,
// name, when added — and nothing of their own data. An instance read: an instance admin's session or token (issue #240), or loopback
// without one (a LAN or public request without a session is refused by the Host guard).
import type { FastifyInstance } from 'fastify';
import type { UserView } from '../domain/types.ts';
import { assertInstanceRead, type InstanceAdmin } from './instance-admin.ts';
import type { Tenants } from './tenants.ts';

export function userRoutes(app: FastifyInstance, o: { tenants: Pick<Tenants, 'list'>; instanceAdmin: InstanceAdmin }): void {
  app.get('/api/users', async (req): Promise<{ users: UserView[] }> => {
    assertInstanceRead(req, o.instanceAdmin, 'list the users');
    return { users: o.tenants.list().map((u) => ({ id: u.id, name: u.name, createdAt: u.createdAt })) };
  });
}
