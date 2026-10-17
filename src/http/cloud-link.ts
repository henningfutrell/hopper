// The cloud link (issue #467, design.md "The cloud link"): the hopper's admin links this install to an account at
// hopper.io, or unlinks it, while it runs. A link writes one record in the instance's settings — a new install id, the
// account, the state — and an unlink deletes it; neither moves, copies or rewrites anything else, restarts the daemon
// or touches a job or a lane. Each is an event. This part makes no connection to hopper.io: a link stays `pending`.
import { randomBytes } from 'node:crypto';
import type { InstanceEvents, InstanceSettingsRepository } from '../domain/ports.ts';
import { normalCloudAccount, type CloudLinkView } from '../domain/cloud-link.ts';
import { HttpError } from './errors.ts';

export interface CloudLink {
  view(): CloudLinkView;
  /** Links this install to `account` (a valid name, normalised). Throws HttpError 409 while it is linked. */
  link(account: string, by: string): CloudLinkView;
  /** Removes the link record; not linked: nothing changes. */
  unlink(by: string): CloudLinkView;
}

export function createCloudLink(o: {
  settings: Pick<InstanceSettingsRepository, 'getCloudLink' | 'setCloudLink' | 'removeCloudLink'>;
  events: Pick<InstanceEvents, 'append'>;
  now: () => Date;
}): CloudLink {
  const view = (): CloudLinkView => ({ link: o.settings.getCloudLink() ?? null });
  return {
    view,
    link(account, by) {
      if (o.settings.getCloudLink()) throw new HttpError(409, 'this install is linked already: unlink it first');
      const link = { installId: randomBytes(16).toString('hex'), account: normalCloudAccount(account), state: 'pending' as const, linkedAt: o.now().toISOString(), by };
      o.settings.setCloudLink(link);
      o.events.append({ type: 'cloud_link.linked', data: { installId: link.installId, account: link.account, by } });
      return view();
    },
    unlink(by) {
      const link = o.settings.getCloudLink();
      if (link) {
        o.settings.removeCloudLink();
        o.events.append({ type: 'cloud_link.unlinked', data: { installId: link.installId, account: link.account, by } });
      }
      return view();
    },
  };
}
