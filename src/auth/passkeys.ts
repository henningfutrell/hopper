// Passkeys for local accounts (issue #1380, design.md "Passkeys for local accounts"): a local account adds a WebAuthn
// credential and then signs in with it in place of its password. Every WebAuthn check is @simplewebauthn/server's — the
// challenge, the origin, the RP ID, user presence and verification, the attestation and the signature —; this module keeps
// the ceremonies' challenges and the rules around them:
// - The relying party is the UI origin's host name: a passkey signs in only at the host name it was added at.
// - Each challenge is used once, by its own ceremony only: a registration's by the session that asked for it, a sign-in's
//   by the flow id the options answered. Both end after CHALLENGE_MS, and at most MAX_CEREMONIES wait at a time.
// - User verification is required (the passkey stands in for the password, so it must prove the person, not only a
//   touch), and the credential is discoverable: the sign-in asks for no email, and the passkey names its account.
// - A passkey of no account, or of a removed one, signs nobody in; the role is the account's own, now.
import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransport, type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Clock, LocalAccount, LocalAccountPasskeyRepository, LocalAccountRepository } from '../domain/ports.ts';
import type { PasskeyView } from '../domain/types.ts';

/** How long a ceremony's challenge waits for its answer. */
export const CHALLENGE_MS = 5 * 60_000;
/** Ceremonies waiting at a time; the oldest is dropped past it (the sign-in rate limit bounds who starts them). */
const MAX_CEREMONIES = 1000;
const RP_NAME = 'hopper';

/** Where a ceremony runs: the UI origin the browser is on, and its host name, the RP ID. */
export interface RelyingParty { id: string; origin: string }
export const relyingParty = (origin: string): RelyingParty => ({ id: new URL(origin).hostname, origin });

/** A refusal with what to say: a WebAuthn answer that does not hold, or a passkey asked for by nobody. */
export class PasskeyRefused extends Error {}

export interface Passkeys {
  any(): boolean;
  view(email: string): PasskeyView[];
  /** The options for a new passkey of the account, the challenge kept for the session `key`. */
  registrationOptions(email: string, key: string, rp: RelyingParty): Promise<PublicKeyCredentialCreationOptionsJSON>;
  /** Check the browser's answer to those options and keep the passkey. Throws PasskeyRefused. */
  register(email: string, key: string, rp: RelyingParty, response: unknown, name: string): Promise<PasskeyView[]>;
  /** False when the account has no passkey of that id. */
  remove(email: string, id: string): boolean;
  /** The options for a sign-in, and the flow id its answer comes back with. */
  signInOptions(rp: RelyingParty): Promise<{ flow: string; options: PublicKeyCredentialRequestOptionsJSON }>;
  /** The account the answer signs in, or why not. */
  signIn(flow: string, rp: RelyingParty, response: unknown): Promise<{ ok: true; account: LocalAccount } | { ok: false; error: string }>;
}

interface Ceremony { challenge: string; rp: RelyingParty; email?: string; until: number }

export function createPasskeys(o: {
  accounts: Pick<LocalAccountRepository, 'get'>; passkeys: LocalAccountPasskeyRepository; clock: Clock;
}): Passkeys {
  const waiting = new Map<string, Ceremony>();
  const keep = (key: string, c: Omit<Ceremony, 'until'>) => {
    const now = o.clock.now().getTime();
    for (const [k, v] of waiting) if (v.until <= now) waiting.delete(k);
    waiting.delete(key);
    while (waiting.size >= MAX_CEREMONIES) waiting.delete(waiting.keys().next().value!);
    waiting.set(key, { ...c, until: now + CHALLENGE_MS });
  };
  /** The ceremony, once: taken out whether its answer holds or not. */
  const take = (key: string): Ceremony | undefined => {
    const c = waiting.get(key);
    waiting.delete(key);
    return c && c.until > o.clock.now().getTime() ? c : undefined;
  };
  const view = (email: string): PasskeyView[] => o.passkeys.list(email).map((p) =>
    ({ id: p.id, name: p.name, rpId: p.rpId, createdAt: p.createdAt, ...(p.lastUsedAt ? { lastUsedAt: p.lastUsedAt } : {}) }));
  const registrationKey = (key: string) => `register:${key}`;
  const signInKey = (flow: string) => `sign-in:${flow}`;

  return {
    any: () => o.passkeys.any(),
    view,
    async registrationOptions(email, key, rp) {
      const options = await generateRegistrationOptions({
        rpName: RP_NAME, rpID: rp.id, userName: email, userDisplayName: email, attestationType: 'none',
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: o.passkeys.list(email).filter((p) => p.rpId === rp.id)
          .map((p) => ({ id: p.id, transports: p.transports as AuthenticatorTransport[] })),
      });
      keep(registrationKey(key), { challenge: options.challenge, rp, email });
      return options;
    },
    async register(email, key, rp, response, name) {
      const c = take(registrationKey(key));
      if (!c || c.email !== email || c.rp.origin !== rp.origin) throw new PasskeyRefused('no passkey was asked for by this session here, or it waited too long: start again');
      let verified;
      try {
        verified = await verifyRegistrationResponse({
          response: response as RegistrationResponseJSON, expectedChallenge: c.challenge, expectedOrigin: rp.origin, expectedRPID: rp.id,
          requireUserVerification: true,
        });
      } catch (e) {
        throw new PasskeyRefused(`the passkey was not added: ${(e as Error).message}`);
      }
      if (!verified.verified) throw new PasskeyRefused('the passkey was not added: its answer did not verify');
      const { credential } = verified.registrationInfo;
      if (o.passkeys.get(credential.id)) throw new PasskeyRefused('this passkey is already added');
      o.passkeys.put({
        id: credential.id, email, rpId: rp.id, publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter, transports: credential.transports ?? [], name, createdAt: o.clock.now().toISOString(),
      });
      return view(email);
    },
    remove: (email, id) => o.passkeys.remove(email, id),
    async signInOptions(rp) {
      const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: 'required' });
      const flow = randomBytes(24).toString('base64url');
      keep(signInKey(flow), { challenge: options.challenge, rp });
      return { flow, options };
    },
    async signIn(flow, rp, response) {
      const c = take(signInKey(flow));
      if (!c || c.rp.origin !== rp.origin) return { ok: false, error: 'unknown, used or expired passkey sign-in: start again' };
      const answer = response as AuthenticationResponseJSON;
      const passkey = typeof answer?.id === 'string' ? o.passkeys.get(answer.id) : undefined;
      const account = passkey ? o.accounts.get(passkey.email) : undefined;
      if (!passkey || !account || passkey.rpId !== rp.id) return { ok: false, error: 'unknown passkey: sign in with your password, then add the passkey in Settings' };
      try {
        const r = await verifyAuthenticationResponse({
          response: answer, expectedChallenge: c.challenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: true,
          credential: { id: passkey.id, publicKey: Buffer.from(passkey.publicKey, 'base64url'), counter: passkey.counter, transports: passkey.transports as AuthenticatorTransport[] },
        });
        if (!r.verified) return { ok: false, error: 'the passkey did not verify' };
        o.passkeys.put({ ...passkey, counter: r.authenticationInfo.newCounter, lastUsedAt: o.clock.now().toISOString() });
      } catch (e) {
        return { ok: false, error: `the passkey did not verify: ${(e as Error).message}` };
      }
      return { ok: true, account };
    },
  };
}
