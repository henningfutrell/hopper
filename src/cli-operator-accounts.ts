// Tool accounts from the command line (issue #1128, design.md "Tool accounts"): `hopper accounts` prints who each machine's agent tool
// is signed in as, as GET /api/tool-accounts answers it — the route the Accounts view reads. Never a token.
import { usage, type Call } from './cli-operator-call.ts';

export const ACCOUNTS_USAGE = `  hopper accounts                                    the tool accounts: each account, the machines signed in as it (or as nobody), when each last ran a job, its week windows`;

export function accountsCall(args: string[]): Call {
  if (args.length > 0) throw usage('accounts');
  return { role: 'viewer', path: '/api/tool-accounts' };
}
