// The host link base (issue #712, design.md "The host link base"): Settings → Host link, the hopper's admin's. The address
// people open, apart from the LAN names containers and boxes use (issue #711): a notification's question link, a UI link
// and an artifact's link are built on it when the user set no link base and the hopper has no public URL. GET
// /api/host-link shows it and its default; POST /ui/api/host-link sets it to an origin the hopper answers to, or empty for
// the default. Applies to the next link, without a restart.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { defaultHostLinkBase } from '../../artifacts/index.ts';
import type { HostLinkView } from '../../domain/artifacts.ts';
import type { InstanceSettingsRepository } from '../../domain/settings-store.ts';
import type { Operation } from '../openapi-operation.ts';
import { parseWith } from '../errors.ts';
import { linkBaseOf } from './artifacts.ts';

type Guard = { onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> };

/** An origin the hopper answers to, or empty for the default. */
export const hostLinkBody = z.strictObject({ hostLinkBase: z.string().trim().max(300) });

export const HOST_LINK_OPERATIONS: Operation[] = [
  { method: 'get', path: '/api/host-link', tag: 'Jobs', summary: 'The host link base', description: 'Issue #712: the address people open. `hostLinkBase`: an origin the hopper answers to, or empty for `default` (`http://localhost:<port>`, on the computer that runs the hopper). A notification\'s question link, a UI link and an artifact\'s link are built on the user\'s link base (Settings → Artifacts), else the public URL, else the host link base when set, else a LAN name that is an IP or ends in `.local`, else `default`. Never a bare LAN name such as a container\'s.', returns: '`HostLinkView`' },
  { method: 'post', path: '/ui/api/host-link', tag: 'Jobs', summary: 'Set the host link base', description: 'Only the instance admin (issue #712). `hostLinkBase`: an origin the hopper answers to (scheme, host and port, no path), or empty for the default. Applies to the next link, without a restart.', role: 'admin', body: hostLinkBody, returns: '`HostLinkView`', errors: [400] },
];

export function registerHostLinkRoutes(app: FastifyInstance, o: { instance: Guard; hostLink: Pick<InstanceSettingsRepository, 'getHostLinkBase' | 'setHostLinkBase'>; port: () => number; origins: () => string[] }): void {
  const view = (): HostLinkView => ({ hostLinkBase: o.hostLink.getHostLinkBase(), default: defaultHostLinkBase(o.port()) });
  app.get('/api/host-link', async (): Promise<HostLinkView> => view());
  app.post('/ui/api/host-link', o.instance, async (req): Promise<HostLinkView> => {
    const { hostLinkBase } = parseWith(hostLinkBody, req.body);
    o.hostLink.setHostLinkBase(linkBaseOf(hostLinkBase, o.origins()));
    return view();
  });
}
