// The cloud link (issue #467, design.md "The cloud link"): the hopper's admin links this install to an account at
// hopper.io, or unlinks it, while it runs. A link writes one record in the instance's settings — the instance id, the
// account, the state — and an unlink deletes it; neither moves, copies or rewrites anything else, restarts the daemon
// or touches a job or a lane. Each is an event. This part makes no connection to hopper.io: a link stays `pending` until
// it registers (issue #465, design.md "Registering at hopper.io") with a one-time registration code the admin minted, and
// is `pending` again when hopper.io's account owner unregisters it there (design.md "Unregistering at hopper.io").
// The cloud link key (part 2, design.md "The cloud link key", docs/hopper-io-security.md R4): a link mints one
// Ed25519 key (issue #2039: it signs hopper.io's challenge in the hello, src/http/cloud-link-hello.ts), its private half a
// system secret of the instance's vault, its public half in the record; the admin rotates it on request; an unlink drops it.
import { createHash, generateKeyPairSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { InstanceEvents, InstanceSettingsRepository } from '../domain/ports.ts';
import { CLOUD_LINK_KEY, normalCloudAccount, REGISTRATION_CODE_MINUTES, type CloudLinkKey, type CloudLinkView, type RegistrationCodeMinted, type RegistrationOutcome, type UnregistrationOutcome } from '../domain/cloud-link.ts';
import type { SystemSecrets } from '../vault/system.ts';
import { HttpError } from './errors.ts';

export interface CloudLink {
  view(): CloudLinkView;
  /** Links this install to `account` (a valid name, normalised). Throws HttpError 409 while it is linked. */
  link(account: string, by: string): CloudLinkView;
  /** Removes the link record, its registration code and its cloud link key; not linked: nothing changes. */
  unlink(by: string): CloudLinkView;
  /** A new cloud link key in place of the one before, at once. Throws HttpError 409 while not linked. */
  rotateKey(by: string): CloudLinkView;
  /** A new registration code, in place of any before it; answered once, kept only hashed. Throws HttpError 409 while not linked. */
  mintRegistrationCode(by: string): RegistrationCodeMinted;
  /**
   * The cloud link's registration: hopper.io hands back the code its account owner entered, for `account`. The open,
   * unexpired code of the link's own account registers it and is spent; anything else changes nothing.
   */
  register(code: string, account: string): RegistrationOutcome;
  /**
   * hopper.io removed this instance: its account owner unregistered it there, for `account`. A registered link of that
   * account is `pending` again; its record, its id and everything else on the instance stay. Anything else changes nothing.
   */
  unregister(account: string): UnregistrationOutcome;
}

const hash = (code: string): Buffer => createHash('sha256').update(code).digest();

/**
 * A new Ed25519 key: its private half as the secret keeps it, a JWK with `d` first, so the last 4 characters the vault
 * keeps of a secret are none of it; and its public half, base64url.
 */
function newKey(): { secret: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const { d, x } = privateKey.export({ format: 'jwk' }) as { d: string; x: string };
  return { secret: JSON.stringify({ d, x, crv: 'Ed25519', kty: 'OKP' }), publicKey: x };
}

export function createCloudLink(o: {
  settings: Pick<InstanceSettingsRepository, 'instanceId' | 'getCloudLink' | 'setCloudLink' | 'removeCloudLink' | 'getCloudRegistrationCode' | 'setCloudRegistrationCode' | 'removeCloudRegistrationCode'>;
  /** The instance's system secrets: the cloud link key's private half. */
  secrets: Pick<SystemSecrets, 'keep' | 'drop'>;
  events: Pick<InstanceEvents, 'append'>;
  now: () => Date;
}): CloudLink {
  /** Mints a cloud link key and keeps its private half; throws HttpError 503 when no system secret can be kept (no master key). */
  const mintKey = (by: string, rotated: boolean): CloudLinkKey => {
    const key = newKey();
    const kept = o.secrets.keep(CLOUD_LINK_KEY, key.secret, by, { rotated });
    if (!kept.ok) throw new HttpError(kept.code === 'unavailable' ? 503 : 409, `the cloud link key cannot be kept: ${kept.error}`);
    return { secret: CLOUD_LINK_KEY, publicKey: key.publicKey, createdAt: o.now().toISOString() };
  };
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
      const linkKey = mintKey(by, false);
      const link = { installId: o.settings.instanceId(), account: normalCloudAccount(account), state: 'pending' as const, linkedAt: o.now().toISOString(), by, linkKey };
      o.settings.setCloudLink(link);
      o.events.append({ type: 'cloud_link.linked', data: { installId: link.installId, account: link.account, by } });
      return view();
    },
    unlink(by) {
      const link = o.settings.getCloudLink();
      o.settings.removeCloudRegistrationCode();
      if (link) {
        o.settings.removeCloudLink();
        o.secrets.drop(CLOUD_LINK_KEY, by);
        o.events.append({ type: 'cloud_link.unlinked', data: { installId: link.installId, account: link.account, by } });
      }
      return view();
    },
    rotateKey(by) {
      const link = o.settings.getCloudLink();
      if (!link) throw new HttpError(409, 'this install is not linked: link it first');
      o.settings.setCloudLink({ ...link, linkKey: mintKey(by, true) });
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
    unregister(account) {
      const link = o.settings.getCloudLink();
      if (!link) return 'not-linked';
      if (normalCloudAccount(account) !== link.account) return 'other-account';
      if (link.state !== 'registered') return 'not-registered';
      o.settings.setCloudLink({ installId: link.installId, account: link.account, state: 'pending', linkedAt: link.linkedAt, by: link.by, ...(link.linkKey ? { linkKey: link.linkKey } : {}) });
      o.events.append({ type: 'cloud_link.unregistered', data: { installId: link.installId, account: link.account } });
      return 'unregistered';
    },
  };
}
