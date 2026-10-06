// GET /api/users (issue #158, design.md "Users: one hopper, separate users"): who the users are — id,
// name, when added — and nothing of their own data. An instance read: an admin session or token, or loopback
// without one (a LAN or public request without a session is refused by the Host guard).
import type { FastifyInstance } from 'fastify';
import { roleAllows, type UserView } from '../domain/types.ts';
import { HttpError } from './errors.ts';
import { roleOfRequest, type Tenants } from './tenants.ts';

export function userRoutes(app: FastifyInstance, o: { tenants: Pick<Tenants, 'list'> }): void {
  app.get('/api/users', async (req): Promise<{ users: UserView[] }> => {
    const role = roleOfRequest(req);
    if (role && !roleAllows(role, 'admin')) throw new HttpError(403, `role ${role} may not list the users; it needs admin`);
    return { users: o.tenants.list().map((u) => ({ id: u.id, name: u.name, createdAt: u.createdAt })) };
  });
}
