// The source email match (issue #1380, design.md "The source email match"): an account a person connects from Sources must
// have a verified email equal to the email they signed in with. An instance setting, on by default, that the hopper's admin
// may turn off. Checked when the account is connected, and again at each renewal of its token (service.ts).
import type { ConnectedAccountProvider } from '../domain/types.ts';
import { PROVIDER_NAME } from './at-rest.ts';

/** An email as the match compares it: trimmed, lowercase. */
export const normalEmail = (email: string): string => email.trim().toLowerCase();

/** Why the account cannot be connected for `email`, or undefined when one of its verified emails is that email. */
export function connectRefusal(provider: ConnectedAccountProvider, account: string, email: string, verified: readonly string[] | undefined): string | undefined {
  const want = normalEmail(email);
  const name = PROVIDER_NAME[provider];
  const off = 'or ask the hopper\'s admin to turn off the source email match (Settings → Sign-in)';
  if (verified === undefined) return `${name} did not show the verified emails of ${account}, so the hopper cannot check ${want}, the email you signed in with: ${off}`;
  if (verified.some((e) => normalEmail(e) === want)) return undefined;
  return `the ${name} account ${account} has no verified email ${want}, the email you signed in with: add and verify it at ${name}, then connect again, ${off}`;
}

/** Why a renewal ends the account: it lost the email it was connected for. Undefined while it has it, or its emails are not shown. */
export function renewalRefusal(provider: ConnectedAccountProvider, account: string, email: string, verified: readonly string[] | undefined): string | undefined {
  if (verified === undefined || verified.some((e) => normalEmail(e) === email)) return undefined;
  return `the ${PROVIDER_NAME[provider]} account ${account} no longer has the verified email ${email}, the email it was connected for`;
}
