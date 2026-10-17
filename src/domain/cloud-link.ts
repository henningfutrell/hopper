// The cloud link (issue #467, design.md "The cloud link"): this install linked to an account at hopper.io, so it can be
// seen there. Linking moves no data: it is one record in the instance's settings, and unlinking removes that record and
// nothing else. Registering it (issue #465, design.md "Registering at hopper.io") takes a one-time registration code the
// instance admin minted; hopper.io's account owner can unregister it there again (design.md "Unregistering at
// hopper.io"). Pure.

/** A hopper.io account name: letters, digits and single hyphens inside, at most 39 characters, kept lowercase. */
const ACCOUNT = /^[a-z0-9](?:-?[a-z0-9]){0,38}$/;

/** Why `account` is no hopper.io account name; undefined: it is one. */
export function cloudAccountProblem(account: string): string | undefined {
  return ACCOUNT.test(account) ? undefined : 'a hopper.io account: letters, digits and single hyphens inside, at most 39 characters';
}

/** The account as kept: trimmed, lowercase. */
export const normalCloudAccount = (account: string): string => account.trim().toLowerCase();

/**
 * The link record, the instance's settings record `cloudLink`. `installId`: the instance id (issue #465), the same at
 * every link, so a link again is the same instance at hopper.io; `account`: the hopper.io account it is bound to;
 * `state`: `pending` until it registers, then `registered` (at `registeredAt`); `linkedAt` and `by`: when, and who linked it.
 */
export interface CloudLinkSettings {
  installId: string;
  account: string;
  state: 'pending' | 'registered';
  linkedAt: string;
  registeredAt?: string;
  by: string;
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
});
