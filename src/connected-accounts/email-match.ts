// The source email match (issue #1380, design.md "The source email match"): an account a person connects from Sources must
// have a verified email equal to the email they signed in with. An instance setting, on by default, that the hopper's admin
// may turn off. Checked when the account is connected, and again at each renewal of its token (service.ts).
import type { ConnectedAccount } from '../domain/ports.ts';
import type { ConnectedAccountProvider } from '../domain/types.ts';
import type { AccountIdentity } from './identity.ts';
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

/** The match as the service asks it: at a connect from Sources, and after each renewal. */
export function createEmailMatch(o: {
  /** Whether the setting is on, read at each check; absent: on. */
  on?(): boolean;
  whoIs(provider: ConnectedAccountProvider, token: string): Promise<AccountIdentity>;
  logger: { warn(line: string): void };
}) {
  const on = () => o.on?.() ?? true;
  return {
    /** At a connect for `email` (the session's): the email to keep, or why the account is refused. No email, or the setting off: nothing to keep. */
    atConnect(provider: ConnectedAccountProvider, email: string | undefined, who: AccountIdentity): { matchEmail?: string; refused?: string } {
      if (email === undefined || !on()) return {};
      const refused = connectRefusal(provider, who.account, email, who.verifiedEmails);
      return refused ? { refused } : { matchEmail: normalEmail(email) };
    },
    /** After a renewal of `a`: why it ends, or undefined. GitHub not answering ends nothing: it is logged. */
    async atRenewal(provider: ConnectedAccountProvider, a: ConnectedAccount): Promise<string | undefined> {
      if (!a.matchEmail || !on()) return undefined;
      try {
        return renewalRefusal(provider, a.account, a.matchEmail, (await o.whoIs(provider, a.accessToken)).verifiedEmails);
      } catch (err) {
        o.logger.warn(`hopper: could not check the verified emails of the ${PROVIDER_NAME[provider]} account ${a.account}: ${(err as Error).message}`);
        return undefined;
      }
    },
  };
}
