// The cloud link (issue #467, design.md "The cloud link"): this install linked to an account at hopper.io, so it can be
// seen there. Linking moves no data: it is one record in the instance's settings, and unlinking removes that record and
// nothing else. Registering it (issue #465, design.md "Registering at hopper.io") takes a one-time registration code the
// instance admin minted; hopper.io's account owner can unregister it there again (design.md "Unregistering at
// hopper.io"). Its hopper.io link key (part 2, design.md "The hopper.io link key") is a system secret the record names.
// Pure.
import type { SystemSecretName } from './vault.ts';

/** A hopper.io account name: letters, digits and single hyphens inside, at most 39 characters, kept lowercase. */
const ACCOUNT = /^[a-z0-9](?:-?[a-z0-9]){0,38}$/;

/** Why `account` is no hopper.io account name; undefined: it is one. */
export function cloudAccountProblem(account: string): string | undefined {
  return ACCOUNT.test(account) ? undefined : 'a hopper.io account: letters, digits and single hyphens inside, at most 39 characters';
}

/** The account as kept: trimmed, lowercase. */
export const normalCloudAccount = (account: string): string => account.trim().toLowerCase();

/** The system secret that holds the hopper.io link key's private half (docs/hopper-io-security.md R4). */
export const CLOUD_LINK_KEY = 'cloud-link.link-key' satisfies SystemSecretName;

/**
 * The hopper.io link key as the link record keeps it: `secret`, the system secret its private half is in; `publicKey`,
 * its X25519 public half (32 bytes, base64url), the only half that goes to hopper.io; `createdAt`, when it was minted.
 */
export interface CloudLinkKey { secret: typeof CLOUD_LINK_KEY; publicKey: string; createdAt: string }

/**
 * The link record, the instance's settings record `cloudLink`. `installId`: the instance id (issue #465), the same at
 * every link, so a link again is the same instance at hopper.io; `account`: the hopper.io account it is bound to;
 * `state`: `pending` until it registers, then `registered` (at `registeredAt`); `linkedAt` and `by`: when, and who linked it;
 * `linkKey`: its hopper.io link key, absent on a link made before part 2 until the admin rotates it.
 */
export interface CloudLinkSettings {
  installId: string;
  account: string;
  state: 'pending' | 'registered';
  linkedAt: string;
  registeredAt?: string;
  by: string;
  linkKey?: CloudLinkKey;
}

/** How long a registration code lasts after it is minted, as a join code. */
export const REGISTRATION_CODE_MINUTES = 10;

/** The registration code kept, the instance's settings record `cloudRegistrationCode`: only its SHA-256, never the code. */
export interface CloudRegistrationCode { codeHash: string; expiresAt: string; by: string }

/** What a mint answers, once: the code itself and when it expires. */
export interface RegistrationCodeMinted { code: string; expiresAt: string }

/** What a registration came to: `registered`, or why not — no link, the link's account is another, or no such code now. */
export type RegistrationOutcome = 'registered' | 'not-linked' | 'other-account' | 'no-code';

/** What an unregistration came to: `unregistered`, or why not — no link, the link's account is another, or it is not registered. */
export type UnregistrationOutcome = 'unregistered' | 'not-linked' | 'other-account' | 'not-registered';

/**
 * As GET /api/cloud-link answers it: the link record, or null while this install is not linked; `registrationCode`, while
 * one is open, when it expires and who minted it (never the code).
 */
export interface CloudLinkView { link: CloudLinkSettings | null; registrationCode?: { expiresAt: string; by: string } }

/** The record as kept: its fields only. */
export const cloudLinkRecord = (s: CloudLinkSettings): CloudLinkSettings => ({
  installId: s.installId, account: s.account, state: s.state, linkedAt: s.linkedAt, ...(s.registeredAt ? { registeredAt: s.registeredAt } : {}), by: s.by,
  ...(s.linkKey ? { linkKey: { secret: s.linkKey.secret, publicKey: s.linkKey.publicKey, createdAt: s.linkKey.createdAt } } : {}),
});
