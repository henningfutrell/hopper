// The sandbox playground's routes (issue #1410, design.md "The sandbox playground"): GET /api/sandbox-playground lists
// the user's playground sandboxes and the limits; an admin creates many at once (POST /ui/api/sandbox-playground) and
// destroys one, a selection or all (POST /ui/api/sandbox-playground/destroy). A request names an agent or a template and
// a size, never an image, a mount or a flag. A playground sandbox is no machine: no join code is minted for it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Playground } from '../../sandbox/playground.ts';
import { PlaygroundRefused } from '../../sandbox/playground.ts';
import type { Operation } from '../openapi-operation.ts';
import { HttpError, parseWith } from '../errors.ts';
import { userIdOf, type TenantParts } from '../tenants.ts';

/** The agents whose published box image a playground sandbox runs. */
export const BOX_AGENTS = ['claude'] as const;

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** The most one create asks for: the limits refuse what is over them anyway. */
export const MAX_PLAYGROUND_COUNT = 500;

export const playgroundCreateBody = z.strictObject({
  count: z.number().int().min(1).max(MAX_PLAYGROUND_COUNT).default(1),
  agent: z.enum(BOX_AGENTS).default('claude'),
  template: z.string().min(1).max(64).optional(),
  cpus: z.number().positive().max(1024).optional(),
  memoryMb: z.number().int().positive().max(16 * 1024 * 1024).optional(),
  ttlMinutes: z.number().int().positive().max(366 * 24 * 60).optional(),
});

/** `ids`: these sandboxes of the user's; `all: true`: every one. */
export const playgroundDestroyBody = z.union([
  z.strictObject({ ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_PLAYGROUND_COUNT) }),
  z.strictObject({ all: z.literal(true) }),
]);

const LIMITS = '`limits` are the hopper\'s settings: `maxConcurrent` (HOPPER_SANDBOX_MAX_CONCURRENT, all users together), `maxPerUser` (HOPPER_SANDBOX_MAX_PER_USER), and the `defaults` and `max` of `cpus`, `memoryMb` and `ttlMinutes` (HOPPER_SANDBOX_DEFAULT_* and HOPPER_SANDBOX_MAX_*; the Helm chart\'s `sandbox.*` values).';

/** The playground's part of the API reference (src/http/openapi.ts). */
export const SANDBOX_PLAYGROUND_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/sandbox-playground', tag: 'Machines and usage', summary: 'The sandbox playground', description: `Issue #1410. The user's playground sandboxes, each with its state (\`starting\`, \`running\`, \`failed\` — nothing of it is left —, \`destroying\`), its size and when its time limit ends; how many run now, in all and the user's; and the limits. \`problem\`: why no sandbox can start now (no container runtime). A playground sandbox is no machine: it takes no lane, and GET /api/machines does not list it. ${LIMITS}`, returns: '`{ problem?, limits, running: { all, yours }, sandboxes }`' },
  { method: 'post', path: '/ui/api/sandbox-playground', tag: 'Machines and usage', summary: 'Start playground sandboxes', description: `Issue #1410. Starts \`count\` playground sandboxes on the container runtime the hopper selected (Podman, Docker or Kubernetes), beside the hopper: the published box image of \`agent\`, or the image of \`template\` once it is approved (and its read-only check passed), with the sandbox flags. Each runs its image idle, on a fresh home made for it, with no secret and no join code. \`cpus\` and \`memoryMb\` default to the template's defaults, else the hopper's, and may be at most the hopper's max and the template's; \`ttlMinutes\` defaults to the hopper's, at most its max (a template has no time limit). It starts as many as the limits leave room for and answers at once; each starts after (GET /api/sandbox-playground). \`refused\`: how many it did not start, and the limit that refused them. Past its time limit a sandbox is destroyed. 400 for a size over a max, naming it; 404 for no such template; 409 when the template is not approved, or the hopper has no runtime; 429 when none can start, naming the limit (\`limit\`: \`maxConcurrent\` or \`maxPerUser\`, \`setting\`: its variable). ${LIMITS}`, role: 'admin', body: playgroundCreateBody, returns: '`{ started: Sandbox[], refused?: { count, limit, setting, reason } }`', errors: [400, 404, 409, 429] },
  { method: 'post', path: '/ui/api/sandbox-playground/destroy', tag: 'Machines and usage', summary: 'Destroy playground sandboxes', description: 'Issue #1410. Destroys the user\'s playground sandboxes `ids` names, or all of them (`all: true`): each one\'s container (a pod on Kubernetes) and its home (a volume, or a claim) are removed. One still starting is removed once its start ends. `problems`: the ones not gone yet, with why; a pass every 10 s tries again.', role: 'admin', body: playgroundDestroyBody, returns: '`{ destroyed, problems: { id, problem }[] }`' },
];

export function registerSandboxPlaygroundRoutes(app: FastifyInstance, o: { admin: Guard; tenant: (req: FastifyRequest) => TenantParts; playground: Playground }): void {
  app.get('/api/sandbox-playground', async (req) => {
    o.tenant(req);
    return o.playground.view(userIdOf(req)!);
  });

  app.post('/ui/api/sandbox-playground', o.admin, async (req, reply) => {
    const id = userIdOf(req);
    if (id === undefined) throw new HttpError(401, 'sign in to start playground sandboxes');
    const { count, agent, template: name, cpus, memoryMb, ttlMinutes } = parseWith(playgroundCreateBody, req.body ?? {});
    const template = name === undefined ? undefined : o.tenant(req).vault.view().templates.find((x) => x.name === name);
    if (name !== undefined && !template) throw new HttpError(404, `no template ${name}`);
    try {
      return o.playground.create(id, { count, agent, ...(template ? { template } : {}), size: { ...(cpus !== undefined ? { cpus } : {}), ...(memoryMb !== undefined ? { memoryMb } : {}), ...(ttlMinutes !== undefined ? { ttlMinutes } : {}) } });
    } catch (e) {
      if (!(e instanceof PlaygroundRefused)) throw e;
      if (e.limit) return reply.code(429).send({ error: e.message, limit: e.limit.limit, setting: e.limit.setting });
      throw new HttpError(e.status, e.message);
    }
  });

  app.post('/ui/api/sandbox-playground/destroy', o.admin, async (req) => {
    const id = userIdOf(req);
    if (id === undefined) throw new HttpError(401, 'sign in to destroy playground sandboxes');
    const body = parseWith(playgroundDestroyBody, req.body ?? {});
    return o.playground.destroy(id, 'all' in body ? 'all' : body.ids);
  });
}
