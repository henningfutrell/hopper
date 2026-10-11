// Add machine's routes. Issue #308: a one-time join code, for the session's user: the line the machine runs carries it
// (design.md "Joining a machine"); only the code's hash is written, the machine's join adds it. Issues #603, #708: a
// sandbox box the hopper starts itself through the sandbox module (design.md "Sandbox boxes the hopper launches"), which
// joins with a join code minted for it; a template's box runs only its approved image, with parameters within its
// limits. A request names an agent or a template and its parameters, never an image, a mount or a flag.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock, InstanceStore } from '../../domain/ports.ts';
import { mintJoinCode } from '../../machines/join-code.ts';
import { LaunchRefused, type Sandboxes } from '../../sandbox/service.ts';
import { HttpError, parseWith } from '../errors.ts';
import { userIdOf, type TenantParts } from '../tenants.ts';
import { joinTemplate } from './vault.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const machineJoinBody = z.strictObject({ template: z.string().min(1).max(64).optional() });
/** The agents a sandbox box runs, as the published box images carry them (issue #308). */
export const BOX_AGENTS = ['claude'] as const;
/** A launch's parameters (issue #708): each within what the template allows, checked by the sandbox module. */
export const launchParams = z.strictObject({
  secrets: z.array(z.string().max(64)).max(256).optional(),
  cpus: z.number().positive().max(1024).optional(),
  memoryMb: z.number().int().positive().max(16 * 1024 * 1024).optional(),
  ttlMinutes: z.number().int().positive().max(366 * 24 * 60).optional(),
  profile: z.string().max(300).optional(),
  tools: z.array(z.string().max(32)).max(16).optional(),
});
/** `machine`: the client target the box starts on (issue #708); absent, the computer the hopper runs on. */
export const machineSandboxBody = z.strictObject({ agent: z.enum(BOX_AGENTS).default('claude'), template: z.string().min(1).max(64).optional(), params: launchParams.default({}), machine: z.string().min(1).max(63).optional() });

export function registerMachineJoinRoutes(app: FastifyInstance, o: {
  admin: Guard; tenant: (req: FastifyRequest) => TenantParts; instance: Pick<InstanceStore, 'joinCodes'>; clock: Clock; sandboxes: Pick<Sandboxes, 'launch'>;
}): void {
  app.post('/ui/api/machines/join', o.admin, async (req) => {
    const id = userIdOf(req);
    if (id === undefined) throw new HttpError(401, 'sign in to add a machine');
    // A sandbox box of a template (issue #558): the code names it, so the box joins as an instance of it.
    const template = joinTemplate(o.tenant(req).vault, parseWith(machineJoinBody, req.body ?? {}).template);
    return mintJoinCode(o.instance, o.clock, id, template === undefined ? {} : { template });
  });

  app.post('/ui/api/machines/sandbox', o.admin, async (req) => {
    const id = userIdOf(req);
    if (id === undefined) throw new HttpError(401, 'sign in to add a machine');
    const { agent, template: name, params, machine } = parseWith(machineSandboxBody, req.body ?? {});
    const template = name === undefined ? undefined : o.tenant(req).vault.view().templates.find((x) => x.name === name);
    if (name !== undefined && !template) throw new HttpError(404, `no template ${name}`);
    try {
      return await o.sandboxes.launch(id, { agent, params, ...(template ? { template } : {}), ...(machine ? { machine } : {}) });
    } catch (e) {
      if (e instanceof LaunchRefused) throw new HttpError(e.status, e.message);
      throw new HttpError(502, `the sandbox box did not start: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}
