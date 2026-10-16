// The source email match (issue #1380, design.md "The source email match"): Settings → Sign-in, the hopper's admin's.
// GET /api/source-email-match shows whether it is on; POST /ui/api/source-email-match turns it on or off. It applies at once.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SourceEmailMatch, SourceEmailMatchView } from '../source-email-match.ts';
import { assertInstanceRead, type InstanceAdmin } from '../instance-admin.ts';
import type { Operation } from '../openapi-operation.ts';
import { parseWith } from '../errors.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const sourceEmailMatchBody = z.strictObject({ on: z.boolean() });

export const SOURCE_EMAIL_MATCH_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/source-email-match', tag: 'Sign-in', summary: 'Whether a source must match the email you signed in with', description: 'Only the instance admin (issue #1380). `on`: a GitHub account a person connects from Sources must have, among its verified emails, the email they signed in with; each renewal of its token checks it again. On by default.', returns: '`{ on: boolean }`', errors: [403] },
  { method: 'post', path: '/ui/api/source-email-match', tag: 'Sign-in', summary: 'Turn the source email match on or off', description: 'Only the instance admin (issue #1380). `on`: true or false. Applies at once, to the next connect and the next renewal; an account already connected is not checked again until its next renewal. A change is `source_email_match.changed`.', role: 'admin', body: sourceEmailMatchBody, returns: '`{ on: boolean }`', errors: [400, 403] },
];

export function registerSourceEmailMatchRoutes(app: FastifyInstance, o: { instance: Guard; instanceAdmin: InstanceAdmin; sourceEmailMatch: SourceEmailMatch; by: (req: FastifyRequest) => string }): void {
  app.get('/api/source-email-match', async (req): Promise<SourceEmailMatchView> => {
    assertInstanceRead(req, o.instanceAdmin, 'read the source email match');
    return o.sourceEmailMatch.view();
  });
  app.post('/ui/api/source-email-match', o.instance, async (req): Promise<SourceEmailMatchView> => o.sourceEmailMatch.change(parseWith(sourceEmailMatchBody, req.body).on, o.by(req)));
}
