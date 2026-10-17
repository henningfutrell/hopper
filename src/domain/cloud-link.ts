// The cloud link (issue #467, design.md "The cloud link"): this install linked to an account at hopper.io, so it can be
// seen there. Linking moves no data: it is one record in the instance's settings, and unlinking removes that record and
// nothing else. Pure.

/** A hopper.io account name: letters, digits and single hyphens inside, at most 39 characters, kept lowercase. */
const ACCOUNT = /^[a-z0-9](?:-?[a-z0-9]){0,38}$/;

/** Why `account` is no hopper.io account name; undefined: it is one. */
export function cloudAccountProblem(account: string): string | undefined {
  return ACCOUNT.test(account) ? undefined : 'a hopper.io account: letters, digits and single hyphens inside, at most 39 characters';
}

/** The account as kept: trimmed, lowercase. */
export const normalCloudAccount = (account: string): string => account.trim().toLowerCase();

/**
 * The link record, the instance's settings record `cloudLink`. `installId`: this install's id at hopper.io, made at the
 * link; `account`: the hopper.io account it is bound to; `state`: `pending` until hopper.io confirms the link; `linkedAt`
 * and `by`: when, and who linked it.
 */
export interface CloudLinkSettings {
  installId: string;
  account: string;
  state: 'pending';
  linkedAt: string;
  by: string;
}

/** As GET /api/cloud-link answers it: the link record, or null while this install is not linked. */
export interface CloudLinkView { link: CloudLinkSettings | null }

/** The record as kept: its fields only. */
export const cloudLinkRecord = (s: CloudLinkSettings): CloudLinkSettings => ({ installId: s.installId, account: s.account, state: s.state, linkedAt: s.linkedAt, by: s.by });
