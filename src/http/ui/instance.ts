// The UI session's routes that are the hopper's admin's alone (issue #240), behind the `instance` guard: self-update
// (issue #44) and the master key (issue #659).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Updater } from '../../domain/ports.ts';
import { UPDATE_CHANNELS, type MasterKeyView } from '../../domain/types.ts';
import type { MasterKeyStatus } from '../master-key.ts';
import { HttpError, parseWith } from '../errors.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

// Self-update (issue #44): check now, apply the available update, or set the channel / auto-update.
export const updateBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('check') }),
  z.strictObject({ action: z.literal('apply') }),
  z.strictObject({ action: z.literal('settings'), channel: z.enum(UPDATE_CHANNELS).optional(), autoUpdate: z.boolean().optional() }),
]);
/** The master key (issue #659): `reveal` answers the key, once; `saved` records that a person saved it. */
export const masterKeyBody = z.strictObject({ action: z.enum(['reveal', 'saved']) });

export function registerInstanceRoutes(app: FastifyInstance, o: { instance: Guard; updater: Updater; masterKey: MasterKeyStatus }): void {
  // design.md "Self-update": answers the new GET /api/update status. `apply` answers at once (the
  // build runs in the background; the daemon then restarts), or 409 when nothing can be applied.
  app.post('/ui/api/update', o.instance, async (req) => {
    const body = parseWith(updateBody, req.body);
    if (body.action === 'check') return o.updater.check();
    if (body.action === 'settings') {
      const { action: _, ...patch } = body;
      return o.updater.settings(patch);
    }
    const r = o.updater.apply();
    if (!r.ok) throw new HttpError(409, r.error);
    return r.status;
  });

  // design.md "The master key": answers the new GET /api/master-key view, with the key on the one `reveal`.
  app.post('/ui/api/master-key', o.instance, async (req): Promise<MasterKeyView & { key?: string }> => {
    const { action } = parseWith(masterKeyBody, req.body);
    if (action === 'saved') return o.masterKey.saved();
    const key = o.masterKey.reveal();
    if (key === undefined) throw new HttpError(409, 'the master key is not shown: it was shown once already, it was saved, or it was given at launch');
    console.warn('hopper: the master key was shown in the UI, once');
    return { ...o.masterKey.view(), key };
  });
}
