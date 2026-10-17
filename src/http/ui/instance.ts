// The UI session's routes that are the hopper's admin's alone (issue #240), behind the `instance` guard: self-update
// (issue #44), the master key (issue #659), the shared GitHub rate limiter's settings (issue #436, ./github-rate-limiter.ts)
// remote access (issue #880, ./remote-access.ts), the GitHub webhook (issue #1079, ./github-deliveries.ts), the host link base (issue #712, ./host-link.ts), the allowed hosts (issue #1024, ./allowed-hosts.ts) the source email match (issue #1380, ./source-email-match.ts), the cloud link (issue #467, ./cloud-link.ts) and the instance's display name (issue #465, ./display-name.ts).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Updater } from '../../domain/ports.ts';
import { UPDATE_CHANNELS, type MasterKeyRotated, type MasterKeyView } from '../../domain/types.ts';
import type { MasterKeyStatus } from '../master-key.ts';
import { HttpError, parseWith } from '../errors.ts';
import { registerRateLimiterRoutes } from './github-rate-limiter.ts';
import { registerHostLinkRoutes } from './host-link.ts';
import { registerRemoteAccessRoutes } from './remote-access.ts';
import { registerGitHubDeliveriesRoutes } from './github-deliveries.ts';
import type { GitHubDeliveries } from '../github-deliveries.ts';
import { registerAllowedHostsRoutes } from './allowed-hosts.ts';
import type { AllowedHosts } from '../allowed-hosts.ts';
import { registerSourceEmailMatchRoutes } from './source-email-match.ts';
import type { SourceEmailMatch } from '../source-email-match.ts';
import { registerCloudLinkRoutes } from './cloud-link.ts';
import type { CloudLink } from '../cloud-link.ts';
import { registerDisplayNameRoutes } from './display-name.ts';
import type { DisplayName } from '../display-name.ts';
import type { RateLimiterControl } from '../../github-limiter/settings.ts';
import type { InstanceAdmin } from '../instance-admin.ts';
import type { RemoteAccess } from '../remote-access.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

// Self-update (issue #44): check now, apply the available update, or set the channel / auto-update.
export const updateBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('check') }),
  z.strictObject({ action: z.literal('apply') }),
  z.strictObject({ action: z.literal('settings'), channel: z.enum(UPDATE_CHANNELS).optional(), autoUpdate: z.boolean().optional(), canary: z.boolean().optional() }),
]);
/**
 * The master key (issue #659): `reveal` answers the key, once; `saved` records that a person saved it; `rotate` seals every
 * secret again under a new key, in one transaction, and answers the new key, once. `hostSeals` (rotate, issue #1296): the
 * caller seals the new key to the host in the same step; a key the host sealed rotates only so.
 */
export const masterKeyBody = z.strictObject({ action: z.enum(['reveal', 'saved', 'rotate']), hostSeals: z.boolean().optional() });

export function registerInstanceRoutes(app: FastifyInstance, o: { instance: Guard; instanceAdmin: InstanceAdmin; updater: Updater; masterKey: MasterKeyStatus; rateLimiter: RateLimiterControl; remoteAccess: RemoteAccess; githubDeliveries: GitHubDeliveries; allowedHosts: AllowedHosts; sourceEmailMatch: SourceEmailMatch; cloudLink: CloudLink; displayName: DisplayName; hostLink: Parameters<typeof registerHostLinkRoutes>[1]['hostLink']; wsl: boolean; port: () => number; origins: () => string[]; by: (req: FastifyRequest) => string }): void {
  registerRateLimiterRoutes(app, o);
  registerHostLinkRoutes(app, o);
  registerRemoteAccessRoutes(app, o);
  registerGitHubDeliveriesRoutes(app, o);
  registerAllowedHostsRoutes(app, o);
  registerSourceEmailMatchRoutes(app, o);
  registerCloudLinkRoutes(app, o);
  registerDisplayNameRoutes(app, o);
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

  // design.md "The master key": answers the new GET /api/master-key view, with the key on the one `reveal`, and the new
  // key on a `rotate` ("Rotating the master key").
  app.post('/ui/api/master-key', o.instance, async (req): Promise<MasterKeyView & { key?: string } | MasterKeyRotated> => {
    const { action, hostSeals } = parseWith(masterKeyBody, req.body);
    if (action === 'saved') return o.masterKey.saved();
    if (action === 'rotate') return o.masterKey.rotate(o.by(req), { hostSeals: hostSeals === true });
    const key = o.masterKey.reveal();
    if (key === undefined) throw new HttpError(409, 'the master key is not shown: it was shown once already, it was saved, or it was given at launch');
    console.warn('hopper: the master key was shown in the UI, once');
    return { ...o.masterKey.view(), key };
  });
}
