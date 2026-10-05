// GET /api/users (issue #158, design.md "Users: one hopper, separate users"): who the users are — id,
// name, when added — and nothing of their own data. An instance read: an admin session, or loopback
// without one (a LAN or public request without a session is refused by the Host guard).
import type { FastifyInstance } from 'fastify';
import { roleAllows, type UserView } from '../domain/types.ts';
import { HttpError } from './errors.ts';
import { sessionToken } from './host-guard.ts';
import type { Tenants } from './tenants.ts';
import type { UiSessions } from './ui/sessions.ts';

export function userRoutes(app: FastifyInstance, o: { tenants: Pick<Tenants, 'list'>; sessions: UiSessions }): void {
  app.get('/api/users', async (req): Promise<{ users: UserView[] }> => {
    const s = o.sessions.find(sessionToken(req));
    if (s && !roleAllows(s.role, 'admin')) throw new HttpError(403, `role ${s.role} may not list the users; it needs admin`);
    return { users: o.tenants.list().map((u) => ({ id: u.id, name: u.name, createdAt: u.createdAt })) };
  });
}
