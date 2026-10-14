// Tool accounts from the command line (issue #1128, design.md "Tool accounts"): `hopper accounts` prints who each machine's agent tool
// is signed in as, as GET /api/tool-accounts answers it — the route the Accounts view reads. Never a token. A tool sign-in ("Tool
// sign-in"): `sign-in` starts it on a source's machine and prints its login, `sign-in-url` prints the URL to open (an operator's
// session reads it), and `code` gives it the code the sign-in page showed — from stdin, never an argument.
import { parseArgs } from 'node:util';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const ACCOUNTS_USAGE = `  hopper accounts                                    the tool accounts: each account, the machines signed in as it (or as nobody), when each last ran a job, its week windows
  hopper accounts sign-in <source> [--email <email>] start the tool's sign-in on the machine usage source <source> reads; prints its login
  hopper accounts sign-in-url <login>                 the sign-in page to open for that login
  hopper accounts code <login>                        give the sign-in the code its page showed (on stdin, never as an argument)`;

const SIGN_IN = 'accounts sign-in <source> [--email <email>]';

export function accountsCall(args: string[], stdin: () => string): Call {
  const [verb, ...rest] = args;
  if (verb === undefined) return { role: 'viewer', path: '/api/tool-accounts' };
  if (verb === 'sign-in') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { email: { type: 'string' } } });
    if (positionals.length !== 1) throw usage(SIGN_IN);
    const source = positionals[0]!;
    return { role: 'operator', path: '/ui/api/tool-accounts/sign-in', body: async () => ({ source, ...(values.email ? { email: values.email } : {}) }) };
  }
  if (verb === 'sign-in-url' && rest.length === 1) {
    return {
      role: 'operator', path: `/api/logins/${encodeURIComponent(rest[0]!)}`,
      pick: (v) => { const l = v as { status: string; expiresAt: string; verificationUrl?: string }; return { status: l.status, expiresAt: l.expiresAt, url: l.verificationUrl ?? null }; },
    };
  }
  if (verb === 'code' && rest.length === 1) {
    const code = stdin().trim();
    if (!code) throw new OperatorRefusal('no code on stdin: pipe it in, e.g. hopper accounts code <login> < code-file');
    return { role: 'operator', path: `/ui/api/logins/${encodeURIComponent(rest[0]!)}/code`, body: async () => ({ code }) };
  }
  throw usage(`accounts | ${SIGN_IN} | accounts sign-in-url <login> | accounts code <login>`);
}
