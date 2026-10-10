// Add machine's routes. Issue #308: a one-time join code, for the session's user: the line the machine runs carries it
// (design.md "Joining a machine"); only the code's hash is written, the machine's join adds it. Issue #603: a sandbox
// box the hopper starts itself through rootless Podman (design.md "Sandbox boxes the hopper launches"), which joins with
// a join code minted for it; a template's box runs only its approved image. A request names an agent or a template,
// never an image, a mount or a flag.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Clock, InstanceStore } from '../../domain/ports.ts';
import { mintJoinCode } from '../../machines/join-code.ts';
import type { Sandboxes } from '../../sandboxes/service.ts';
import { HttpError, parseWith } from '../errors.ts';
import { userIdOf, type TenantParts } from '../tenants.ts';
import { joinTemplate } from './vault.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

export const machineJoinBody = z.strictObject({ template: z.string().min(1).max(64).optional() });
/** The agents a sandbox box runs, as the published box images carry them (issue #308). */
export const BOX_AGENTS = ['claude'] as const;
export const machineSandboxBody = z.strictObject({ agent: z.enum(BOX_AGENTS).default('claude'), template: z.string().min(1).max(64).optional() });

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
    const { agent, template: name } = parseWith(machineSandboxBody, req.body ?? {});
    let template: { name: string; image: string } | undefined;
    if (name !== undefined) {
      const t = o.tenant(req).vault.view().templates.find((x) => x.name === name);
      if (!t) throw new HttpError(404, `no template ${name}`);
      if (t.approval === undefined || t.pending.image) throw new HttpError(409, `the image of template ${name} is not approved: approve it in Settings → Vault first`);
      template = { name: t.name, image: t.image };
    }
    try {
      return await o.sandboxes.launch(id, { agent, ...(template ? { template } : {}) });
    } catch (e) {
      throw new HttpError(502, `the sandbox box did not start: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}
