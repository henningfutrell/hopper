// The instance's display name (issue #465, design.md "The instance's display name"): Settings → Version, the hopper's admin's.
// GET /api/display-name shows it with the instance id; POST /ui/api/display-name sets or clears it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DisplayName, DisplayNameView } from '../display-name.ts';
import { assertInstanceRead, type InstanceAdmin } from '../instance-admin.ts';
import type { Operation } from '../openapi-operation.ts';
import { parseWith } from '../errors.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** One line of 80 characters at most once trimmed; empty clears it. */
export const DISPLAY_NAME_MAX = 80;
export const displayNameBody = z.strictObject({
  displayName: z.string().trim().max(DISPLAY_NAME_MAX).refine((s) => !/[\p{Cc}]/u.test(s), 'one line, no control characters'),
});

export const DISPLAY_NAME_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/display-name', tag: 'Users', summary: "The instance's display name and instance id", description: 'Only the instance admin (issue #465). `instanceId`: this hopper\'s id, made once and kept in its database (issue #603); `displayName`: what the admin calls this hopper, empty when none.', returns: '`{ instanceId: string, displayName: string }`', errors: [403] },
  { method: 'post', path: '/ui/api/display-name', tag: 'Users', summary: "Set the instance's display name", description: `Only the instance admin (issue #465). \`displayName\`: one line, trimmed, ${DISPLAY_NAME_MAX} characters at most; empty clears it. A change is \`display_name.changed\`.`, role: 'admin', body: displayNameBody, returns: '`{ instanceId: string, displayName: string }`', errors: [400, 403] },
];

export function registerDisplayNameRoutes(app: FastifyInstance, o: { instance: Guard; instanceAdmin: InstanceAdmin; displayName: DisplayName; by: (req: FastifyRequest) => string }): void {
  app.get('/api/display-name', async (req): Promise<DisplayNameView> => {
    assertInstanceRead(req, o.instanceAdmin, "read the instance's display name");
    return o.displayName.view();
  });
  app.post('/ui/api/display-name', o.instance, async (req): Promise<DisplayNameView> => o.displayName.change(parseWith(displayNameBody, req.body).displayName, o.by(req)));
}
