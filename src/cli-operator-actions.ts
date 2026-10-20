// A job's asks for an AWS action from the operator CLI (issue #2206, design.md "Action grants"): list the asks and the
// grants, grant or decline an ask, and revoke a grant. Each is the UI's own `POST /ui/api/sandbox-requests` or
// `POST /ui/api/sandbox-approvals`, so the daemon's checks apply as they do for a click on Access requests.
import { parseArgs } from 'node:util';
import { usage, type Call } from './cli-operator-call.ts';
import type { VaultView } from './domain/vault.ts';

export const ACTION_VERBS = ['actions', 'grant-action', 'decline-action', 'revoke-action'];

export const ACTION_USAGE = `  hopper sandbox actions                             the asks of jobs for an AWS action, on run cards and not, and the grants
  hopper sandbox grant-action <job> <account>/<role> <service:Action>=<resource ARN>
                                                     grant a job's ask: later asks of the same scope are covered too
  hopper sandbox decline-action <job> <account>/<role> <service:Action>=<resource ARN> [--reason <text>]
                                                     decline a job's ask: its step is told no
  hopper sandbox revoke-action <account>/<role> <service:Action>=<resource ARN>   revoke an action grant now`;

const VERBS = 'sandbox actions | grant-action <job> <account>/<role> <service:Action>=<ARN> | decline-action <job> <account>/<role> <service:Action>=<ARN> [--reason <text>] | revoke-action <account>/<role> <service:Action>=<ARN>';

/** The scope `<role> <service:Action>=<ARN>` names; undefined: it names none. The daemon checks the rest. */
function scopeOf(role: string | undefined, said: string | undefined): { role: string; action: string; resource: string } | undefined {
  const at = said?.indexOf('=') ?? -1;
  if (!role || !said || at <= 0 || at === said.length - 1) return undefined;
  return { role, action: said.slice(0, at), resource: said.slice(at + 1) };
}

export function actionCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' } } });
  const [verb, ...extra] = positionals;
  const { reason } = values;
  if (verb === 'actions' && extra.length === 0 && reason === undefined) {
    const pick = (v: unknown) => { const x = v as VaultView; return { asks: [...(x.runs ?? []).flatMap((r) => r.actions ?? []), ...(x.actionAsks ?? [])], grants: x.actionGrants ?? [] }; };
    return { role: 'viewer', path: '/api/vault', pick };
  }
  if (verb === 'revoke-action') {
    const scope = scopeOf(extra[0], extra[1]);
    if (!scope || extra.length !== 2 || reason !== undefined) throw usage(VERBS);
    return { role: 'admin', path: '/ui/api/sandbox-approvals', pick: (v) => (v as VaultView).actionGrants ?? [], body: async () => ({ revokeAction: scope }) };
  }
  const [job, role, said, ...more] = extra;
  const scope = scopeOf(role, said);
  if ((verb !== 'grant-action' && verb !== 'decline-action') || !job || !scope || more.length > 0 || (verb === 'grant-action' && reason !== undefined)) throw usage(VERBS);
  return { role: 'admin', path: '/ui/api/sandbox-requests', pick: (v) => (v as VaultView).actionGrants ?? [], body: async () => ({ action: verb, job, grant: scope, ...(reason !== undefined ? { reason } : {}) }) };
}
