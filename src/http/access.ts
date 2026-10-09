// Access (issue #559): GET /api/access, Settings → Access — whether OpenFGA can be asked, the model, each template's
// approvals with the relationship chain, the revoked ones, the newest decisions. The instance's: its admin's alone.
import type { FastifyInstance } from 'fastify';
import type { Access } from '../authz/service.ts';
import type { AccessView } from '../domain/types.ts';
import { assertInstanceRead, type InstanceAdmin } from './instance-admin.ts';

export function accessRoutes(app: FastifyInstance, o: { access: Pick<Access, 'view'>; instanceAdmin: InstanceAdmin }): void {
  app.get('/api/access', async (req): Promise<AccessView> => {
    assertInstanceRead(req, o.instanceAdmin, 'read access');
    return o.access.view();
  });
}
