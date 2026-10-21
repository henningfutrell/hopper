// Access (issue #559): GET /api/access, Users & access → Access — whether OpenFGA can be asked, the model, each template's
// approvals with the relationship chain, the revoked ones, the newest decisions. The instance's: its admin's alone.
// GET /api/access/status (issue #696): whether OpenFGA can be asked, for every reader — the banner and the forms that
// need Access say so before a save is tried. The state and why only: no store, no model.
import type { FastifyInstance } from 'fastify';
import type { Access } from '../authz/service.ts';
import type { AccessStatus, AccessView } from '../domain/types.ts';
import type { Operation } from './openapi-operation.ts';
import { assertInstanceRead, type InstanceAdmin } from './instance-admin.ts';

export type AccessStatusView = Pick<AccessStatus, 'state' | 'why'>;

export const ACCESS_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/access', tag: 'Access', summary: 'Access: OpenFGA, the model, the approvals, the decisions', description: 'Only the instance admin (issue #559). `status` — whether OpenFGA can be asked (`not-configured`, `connected`: everything pushed, `unreachable`: every mint is denied) and `why` not; `model` — the access model (OpenFGA DSL) and its `version`; `templates` — each template with an approval or a vault template of its name: its approvals, each an operation profile (an operation on an asset) with who approved it, when, and the relationship `chain` from the template to the asset, and its `radius` (issue #584: `level`, the `reasons` that set it, and each operation profile with its level and whether it is approved); `revoked` — the newest revoked approvals; `decisions` — the newest mint decisions, each allowed or denied with its reason and, allowed, the relationship `path` from the job.', returns: '`AccessView`', errors: [403] },
  { method: 'get', path: '/api/access/status', tag: 'Access', summary: 'Whether access checks can be made', description: 'Issue #696. `state`: `connected`, `not-configured` (no OpenFGA set up) or `unreachable` (OpenFGA not reached, or it refused what the hopper pushed), and `why` when not connected. While it is not `connected`, every change that needs Access (the TypeSafe API key) answers 503. Any reader: nothing of the store or the model.', returns: '`{ state, why? }`' },
];

export function accessRoutes(app: FastifyInstance, o: { access: Pick<Access, 'view' | 'status'>; instanceAdmin: InstanceAdmin }): void {
  app.get('/api/access', async (req): Promise<AccessView> => {
    assertInstanceRead(req, o.instanceAdmin, 'read access');
    return o.access.view();
  });
  app.get('/api/access/status', async (): Promise<AccessStatusView> => {
    const { state, why } = o.access.status();
    return why === undefined ? { state } : { state, why };
  });
}
