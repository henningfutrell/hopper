// The cloud link (issue #467, design.md "The cloud link"): the hopper's admin links this install to an account at
// hopper.io, or unlinks it, while it runs. A link writes one record in the instance's settings — the instance id, the
// account, the state — and an unlink deletes it; neither moves, copies or rewrites anything else, restarts the daemon
// or touches a job or a lane. Each is an event. This part makes no connection to hopper.io: a link stays `pending` until
// it registers (issue #465, design.md "Registering at hopper.io") with a one-time registration code the admin minted.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { InstanceEvents, InstanceSettingsRepository } from '../domain/ports.ts';
import { normalCloudAccount, REGISTRATION_CODE_MINUTES, type CloudLinkView, type RegistrationCodeMinted, type RegistrationOutcome } from '../domain/cloud-link.ts';
import { HttpError } from './errors.ts';

export interface CloudLink {
  view(): CloudLinkView;
  /** Links this install to `account` (a valid name, normalised). Throws HttpError 409 while it is linked. */
  link(account: string, by: string): CloudLinkView;
  /** Removes the link record and its registration code; not linked: nothing changes. */
  unlink(by: string): CloudLinkView;
  /** A new registration code, in place of any before it; answered once, kept only hashed. Throws HttpError 409 while not linked. */
  mintRegistrationCode(by: string): RegistrationCodeMinted;
  /**
   * The cloud link's registration: hopper.io hands back the code its account owner entered, for `account`. The open,
   * unexpired code of the link's own account registers it and is spent; anything else changes nothing.
   */
  register(code: string, account: string): RegistrationOutcome;
}

const hash = (code: string): Buffer => createHash('sha256').update(code).digest();

export function createCloudLink(o: {
  settings: Pick<InstanceSettingsRepository, 'instanceId' | 'getCloudLink' | 'setCloudLink' | 'removeCloudLink' | 'getCloudRegistrationCode' | 'setCloudRegistrationCode' | 'removeCloudRegistrationCode'>;
  events: Pick<InstanceEvents, 'append'>;
  now: () => Date;
}): CloudLink {
  /** The open code, or undefined; an expired one is removed. */
  const openCode = () => {
    const code = o.settings.getCloudRegistrationCode();
    if (code && code.expiresAt <= o.now().toISOString()) { o.settings.removeCloudRegistrationCode(); return undefined; }
    return code;
  };
  const view = (): CloudLinkView => {
    const code = openCode();
    return { link: o.settings.getCloudLink() ?? null, ...(code ? { registrationCode: { expiresAt: code.expiresAt, by: code.by } } : {}) };
  };
  return {
    view,
    link(account, by) {
      if (o.settings.getCloudLink()) throw new HttpError(409, 'this install is linked already: unlink it first');
      const link = { installId: o.settings.instanceId(), account: normalCloudAccount(account), state: 'pending' as const, linkedAt: o.now().toISOString(), by };
      o.settings.setCloudLink(link);
      o.events.append({ type: 'cloud_link.linked', data: { installId: link.installId, account: link.account, by } });
      return view();
    },
    unlink(by) {
      const link = o.settings.getCloudLink();
      o.settings.removeCloudRegistrationCode();
      if (link) {
        o.settings.removeCloudLink();
        o.events.append({ type: 'cloud_link.unlinked', data: { installId: link.installId, account: link.account, by } });
      }
      return view();
    },
    mintRegistrationCode(by) {
      const link = o.settings.getCloudLink();
      if (!link) throw new HttpError(409, 'this install is not linked: link it first');
      const code = randomBytes(32).toString('hex');
      const expiresAt = new Date(o.now().getTime() + REGISTRATION_CODE_MINUTES * 60_000).toISOString();
      o.settings.setCloudRegistrationCode({ codeHash: hash(code).toString('hex'), expiresAt, by });
      o.events.append({ type: 'cloud_link.registration_code_minted', data: { installId: link.installId, account: link.account, expiresAt, by } });
      return { code, expiresAt };
    },
    register(code, account) {
      const link = o.settings.getCloudLink();
      if (!link) return 'not-linked';
      const open = openCode();
      if (!open || !/^[0-9a-f]{64}$/.test(code) || !timingSafeEqual(hash(code), Buffer.from(open.codeHash, 'hex'))) return 'no-code';
      if (normalCloudAccount(account) !== link.account) return 'other-account';
      o.settings.removeCloudRegistrationCode();
      o.settings.setCloudLink({ ...link, state: 'registered', registeredAt: o.now().toISOString() });
      o.events.append({ type: 'cloud_link.registered', data: { installId: link.installId, account: link.account } });
      return 'registered';
    },
  };
}
