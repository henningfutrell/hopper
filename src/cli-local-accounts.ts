// Local accounts from the command line (issue #1380, design.md "Local accounts"): the operator's way to the first admin of a
// hopper with no identity provider, and back in after a lockout. It writes the database directly, as the rest of the CLI:
// whoever runs it holds the database's credentials. A password comes on stdin, never as an argument. A running daemon
// takes a new account or password at the next sign-in; the sessions of a removed or lowered account follow at its next start.
import { parseArgs } from 'node:util';
import { accountEmail, hashPassword, passwordSchema } from './auth/local-accounts.ts';
import type { InstanceStore } from './domain/ports.ts';
import { UI_ROLES, type UiRole } from './domain/types.ts';

export const LOCAL_ACCOUNT_USAGE = `  hopper local-account list                          the local accounts: email, role, when added
  hopper local-account add <email> [--role <role>]   add a local account (role admin unless given; viewer, operator or admin),
                                                     its password on stdin: the first admin of a hopper with no identity provider
  hopper local-account password <email>              set a local account's password, the new one on stdin
  hopper local-account remove <email>                remove a local account`;

export class LocalAccountUsage extends Error {}

const usage = (): LocalAccountUsage => new LocalAccountUsage('usage: hopper local-account list | add <email> [--role <role>] | password <email> | remove <email>');

const emailOf = (raw: string | undefined): string => {
  const r = accountEmail.safeParse(raw?.trim());
  if (!r.success) throw raw ? new LocalAccountUsage(`${raw} is not an email`) : usage();
  return r.data;
};

const passwordOf = (stdin: () => string): string => {
  const r = passwordSchema.safeParse(stdin().replace(/\r?\n$/, ''));
  if (!r.success) throw new LocalAccountUsage(`the password on stdin ${r.error.issues[0]!.message}`);
  return r.data;
};

export async function localAccountCommand(instance: Pick<InstanceStore, 'localAccounts'>, args: string[], io: { stdin(): string; out(t: string): void; err(t: string): void }, now: () => Date): Promise<void> {
  const [verb, ...rest] = args;
  const accounts = instance.localAccounts;
  if (verb === 'list' && rest.length === 0) {
    for (const a of accounts.list()) io.out(`${a.email}\t${a.role}\t${a.createdAt}\n`);
    return;
  }
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { role: { type: 'string' } } });
  if (positionals.length !== 1) throw usage();
  const email = emailOf(positionals[0]);
  const existing = accounts.get(email);
  if (verb === 'add') {
    const role = (values.role ?? 'admin') as UiRole;
    if (!UI_ROLES.includes(role)) throw new LocalAccountUsage(`role ${values.role}: one of ${UI_ROLES.join(', ')}`);
    if (existing) throw new LocalAccountUsage(`there is a local account ${email}: set its password with hopper local-account password ${email}`);
    accounts.put({ email, role, passwordHash: await hashPassword(passwordOf(io.stdin)), createdAt: now().toISOString() });
    io.err(`local account ${email} added, role ${role}: sign in with it on the sign-in page\n`);
  } else if (verb === 'password' && values.role === undefined) {
    if (!existing) throw new LocalAccountUsage(`no local account ${email}`);
    accounts.put({ ...existing, passwordHash: await hashPassword(passwordOf(io.stdin)) });
    io.err(`the password of ${email} is set\n`);
  } else if (verb === 'remove' && values.role === undefined) {
    if (!accounts.remove(email)) throw new LocalAccountUsage(`no local account ${email}`);
    io.err(`local account ${email} removed\n`);
  } else {
    throw usage();
  }
}
