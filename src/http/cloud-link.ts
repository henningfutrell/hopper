// The cloud link (issue #467, design.md "The cloud link"): the hopper's admin links this install to an account at
// hopper.io, or unlinks it, while it runs. A link writes one record in the instance's settings — the instance id, the
// account, the state — and an unlink deletes it; neither moves, copies or rewrites anything else, restarts the daemon
// or touches a job or a lane. Each is an event. This part makes no connection to hopper.io: a link stays `pending` until
// it registers (issue #465, design.md "Registering at hopper.io") with a one-time registration code the admin minted, and
// is `pending` again when hopper.io's account owner unregisters it there (design.md "Unregistering at hopper.io").
// The cloud link key (part 2, design.md "The cloud link key", docs/hopper-io-security.md R4): a link mints one
// Ed25519 key (issue #2039: it signs hopper.io's challenge in the hello, src/http/cloud-link-hello.ts), its private half a
// system secret of the instance's vault, its public half in the record; the admin rotates it on request; an unlink drops it.
// Issue #2039 part 2: a rotation keeps the key before (`previousKey`) until the new key connected, so hopper.io moves its
// registration only on a hello that proves both (R4); the admin revokes the key, which keeps the link with no key until a
// rotation; the cloud link's agent (cloud-link-agent.ts) mints a key for a link that has none, and is told of each change.
import { createHash, generateKeyPairSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { InstanceEvents, InstanceSettingsRepository } from '../domain/ports.ts';
import { CLOUD_LINK_KEY, CLOUD_LINK_PREVIOUS_KEY, normalCloudAccount, REGISTRATION_CODE_MINUTES, type CloudConnectionView, type CloudLinkKey, type CloudLinkSettings, type CloudLinkView, type RegistrationCodeMinted, type RegistrationOutcome, type UnregistrationOutcome } from '../domain/cloud-link.ts';
import type { SystemSecrets } from '../vault/system.ts';
import { HttpError } from './errors.ts';

export interface CloudLink {
  view(): CloudLinkView;
  /** Links this install to `account` (a valid name, normalised). Throws HttpError 409 while it is linked. */
  link(account: string, by: string): CloudLinkView;
  /** Removes the link record, its registration code and its cloud link key; not linked: nothing changes. */
  unlink(by: string): CloudLinkView;
  /**
   * A new cloud link key in place of the one before, at once; the one before is kept as `previousKey` until the new key
   * connected (the first one before, after two rotations). Throws HttpError 409 while not linked.
   */
  rotateKey(by: string): CloudLinkView;
  /** Drops the key and the key before; the link stays, with no key, until a rotation. Throws HttpError 409 while not linked. */
  revokeKey(by: string): CloudLinkView;
  /**
   * The link record, with a key: a link with none gets one now, as the hopper, unless its key was revoked. Undefined while
   * not linked. Throws HttpError 503 when no system secret can be kept (no master key).
   */
  ensureKey(): CloudLinkSettings | undefined;
  /** hopper.io took the connection of `publicKey`: when it is the link's key, the key before is dropped. */
  keyConnected(publicKey: string): void;
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
  secrets: Pick<SystemSecrets, 'keep' | 'drop' | 'open'>;
  events: Pick<InstanceEvents, 'append'>;
  now: () => Date;
  /** Told after the admin links, unlinks, rotates or revokes, with the record before: the cloud link's agent. */
  changed?: (before: CloudLinkSettings | undefined) => void;
  /** The connection now, for the view while linked: the cloud link's agent's. */
  connection?: () => CloudConnectionView;
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
    const link = o.settings.getCloudLink() ?? null;
    return { link, ...(code ? { registrationCode: { expiresAt: code.expiresAt, by: code.by } } : {}), ...(link && o.connection ? { connection: o.connection() } : {}) };
  };
  /** The admin's change: written, then the agent told, with the record before. */
  const change = (before: CloudLinkSettings | undefined): CloudLinkView => { o.changed?.(before); return view(); };
  const dropPrevious = (link: CloudLinkSettings, by: string): CloudLinkSettings => {
    const { previousKey, ...rest } = link;
    if (previousKey) o.secrets.drop(CLOUD_LINK_PREVIOUS_KEY, by);
    return rest;
  };
  return {
    view,
    link(account, by) {
      if (o.settings.getCloudLink()) throw new HttpError(409, 'this install is linked already: unlink it first');
      const linkKey = mintKey(by, false);
      const link = { installId: o.settings.instanceId(), account: normalCloudAccount(account), state: 'pending' as const, linkedAt: o.now().toISOString(), by, linkKey };
      o.settings.setCloudLink(link);
      o.events.append({ type: 'cloud_link.linked', data: { installId: link.installId, account: link.account, by } });
      return change(undefined);
    },
    unlink(by) {
      const link = o.settings.getCloudLink();
      o.settings.removeCloudRegistrationCode();
      if (link) {
        o.settings.removeCloudLink();
        o.secrets.drop(CLOUD_LINK_KEY, by);
        if (link.previousKey) o.secrets.drop(CLOUD_LINK_PREVIOUS_KEY, by);
        o.events.append({ type: 'cloud_link.unlinked', data: { installId: link.installId, account: link.account, by } });
        return change(link);
      }
      return view();
    },
    rotateKey(by) {
      const link = o.settings.getCloudLink();
      if (!link) throw new HttpError(409, 'this install is not linked: link it first');
      // The first key before stays: hopper.io may still have it bound, as no key after it connected.
      let previousKey = link.previousKey;
      if (!previousKey && link.linkKey) {
        const secret = o.secrets.open(CLOUD_LINK_KEY, 'keep the cloud link key until the new one connected');
        const kept = secret === undefined ? undefined : o.secrets.keep(CLOUD_LINK_PREVIOUS_KEY, secret, by);
        if (kept?.ok) previousKey = { ...link.linkKey, secret: CLOUD_LINK_PREVIOUS_KEY };
      }
      const { keyRevokedAt: _revoked, previousKey: _previous, ...rest } = link;
      o.settings.setCloudLink({ ...rest, linkKey: mintKey(by, true), ...(previousKey ? { previousKey } : {}) });
      return change(link);
    },
    revokeKey(by) {
      const link = o.settings.getCloudLink();
      if (!link) throw new HttpError(409, 'this install is not linked: link it first');
      o.secrets.drop(CLOUD_LINK_KEY, by);
      const { linkKey: _key, ...rest } = dropPrevious(link, by);
      o.settings.setCloudLink({ ...rest, keyRevokedAt: o.now().toISOString() });
      o.events.append({ type: 'cloud_link.revoked', data: { installId: link.installId, account: link.account, by } });
      return change(link);
    },
    ensureKey() {
      const link = o.settings.getCloudLink();
      if (!link || link.linkKey || link.keyRevokedAt) return link;
      const minted = { ...link, linkKey: mintKey('hopper', false) };
      o.settings.setCloudLink(minted);
      return minted;
    },
    keyConnected(publicKey) {
      const link = o.settings.getCloudLink();
      if (link?.previousKey && link.linkKey?.publicKey === publicKey) o.settings.setCloudLink(dropPrevious(link, 'hopper'));
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
      const { registeredAt: _at, ...rest } = link;
      o.settings.setCloudLink({ ...rest, state: 'pending' });
      o.events.append({ type: 'cloud_link.unregistered', data: { installId: link.installId, account: link.account } });
      return 'unregistered';
    },
  };
}
