// Settings → GitHub webhook (issue #1079, design.md "GitHub deliveries"), the hopper's admin's: GET /api/github-deliveries
// shows where GitHub sends its deliveries, the events to pick, the GitHub webhook secret's metadata (never its value) and
// what came in since the start; POST /ui/api/github-deliveries makes the secret — answered once, a second make rotates it
// — or removes it, so nothing is taken.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { GitHubDeliveriesView } from '../../domain/github-deliveries.ts';
import { assertInstanceRead, type InstanceAdmin } from '../instance-admin.ts';
import type { Operation } from '../openapi-operation.ts';
import type { GitHubDeliveries } from '../github-deliveries.ts';
import { parseWith } from '../errors.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const githubDeliveriesBody = z.strictObject({ action: z.enum(['make', 'remove']) });

const VIEW = '`path`: where GitHub, or a relay in front of the hopper, sends its deliveries (`/github/webhook`); `events`: the events to pick (`issues`); `secret`: whether the GitHub webhook secret is set, who made it, when, and its last 4 characters, never its value; `problem`: why none can be kept now (no master key); `received`, `refused`, `ignored`: deliveries since the start — taken, refused for their signature, of an event or action the hopper does not read —; `last`, `lastRefused`: the last of each.';

export const GITHUB_DELIVERIES_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/github-deliveries', tag: 'Jobs', summary: 'GitHub deliveries: the webhook\'s settings and what came in', description: `Only the instance admin (issue #1079). ${VIEW}`, returns: '`GitHubDeliveriesView`', errors: [403] },
  { method: 'post', path: '/ui/api/github-deliveries', tag: 'Jobs', summary: 'Make or remove the GitHub webhook secret', description: `Only the instance admin (issue #1079). \`make\`: a new GitHub webhook secret (32 random bytes, hex), kept sealed in the instance's vault as a system secret and answered once (\`generatedSecret\`); a second make rotates it, and a delivery signed with the old one is refused. \`remove\`: none, so \`POST /github/webhook\` takes nothing. 503 when no master key is given. ${VIEW}`, role: 'admin', body: githubDeliveriesBody, returns: '`GitHubDeliveriesView` (with `generatedSecret` after a make)', errors: [400, 403, 503] },
];

export function registerGitHubDeliveriesRoutes(app: FastifyInstance, o: { instance: Guard; instanceAdmin: InstanceAdmin; githubDeliveries: Pick<GitHubDeliveries, 'view' | 'change'>; by: (req: FastifyRequest) => string }): void {
  app.get('/api/github-deliveries', async (req): Promise<GitHubDeliveriesView> => {
    assertInstanceRead(req, o.instanceAdmin, 'read the GitHub webhook');
    return o.githubDeliveries.view();
  });
  app.post('/ui/api/github-deliveries', o.instance, async (req, reply) => {
    const { action } = parseWith(githubDeliveriesBody, req.body);
    reply.header('cache-control', 'no-store');
    return o.githubDeliveries.change(action, o.by(req));
  });
}
