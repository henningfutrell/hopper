// Yolo mode (issue #579, design.md "Done is a pull request"): whether jobs may merge their own pull requests once the
// repo's checks pass. Off unless an admin turns it on, for every job repository or per repository; read each time a
// job's prompt is built, so it applies to the next job without a restart. Done never depends on it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DEFAULT_YOLO_MODE, patchYoloMode, type YoloModeSettings, type YoloModeView } from '../../domain/types.ts';
import type { UserStore } from '../../domain/store.ts';
import { HttpError, parseWith } from '../errors.ts';
import { signedInOf, type TenantParts } from '../tenants.ts';
import { identityName } from './sessions.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

const repoName = z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/repo').max(200);
/** Any part; `repos` sets each named repository on or off, or `null` to follow `on` again. */
export const yoloModeBody = z.strictObject({
  on: z.boolean().optional(),
  repos: z.record(repoName, z.boolean().nullable()).optional(),
}).refine((b) => b.on !== undefined || b.repos !== undefined, { message: 'name on or repos' });

const settingsOf = (store: UserStore): YoloModeSettings => store.settings.getYoloMode() ?? DEFAULT_YOLO_MODE;

export function yoloModeView(t: Pick<TenantParts, 'store'>): YoloModeView {
  return { ...settingsOf(t.store), choices: { repos: t.store.settings.getJobRepositories('github') } };
}

export function registerYoloModeRoutes(app: FastifyInstance, o: { operator: Guard; admin: Guard; tenant: (req: FastifyRequest) => TenantParts }): void {
  app.post('/ui/api/yolo-mode', o.admin, async (req) => {
    const s = signedInOf(req);
    if (!s) throw new HttpError(401, 'sign in to change yolo mode');
    const t = o.tenant(req);
    const patch = parseWith(yoloModeBody, req.body);
    t.store.tx(() => {
      const from = settingsOf(t.store);
      const to = patchYoloMode(from, patch);
      if (JSON.stringify(from) === JSON.stringify(to)) return;
      t.store.settings.setYoloMode(to);
      t.store.events.append({ type: 'yolo_mode.changed', data: { from, to, by: identityName(s.identity) } });
    });
    return yoloModeView(t);
  });
}
