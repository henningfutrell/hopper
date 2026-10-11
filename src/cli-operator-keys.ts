// The keys from the command line. The TypeSafe API key (issue #657): read from stdin, never an argument. The master key's
// status (issue #685, design.md "The master key"): where the running daemon's key came from, its fingerprint, and whether a
// previous key is set; never the key. Its rotation (issue #659, "Rotating the master key"): the one answer that carries a
// key — the new one, once, to stdout, never to the log. API tokens (issue #718, design.md "API tokens"): mint one for an
// agent — a box token with --box (issue #795) —, list them, revoke one; the token is printed once, by the mint.
import { parseArgs } from 'node:util';
import { UI_ROLES, type MasterKeyRotated, type MasterKeyView, type UiRole } from './domain/types.ts';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const MASTER_KEY_USAGE = `  hopper master-key status                           the master key: where it came from (source), its fingerprint, and whether
                                                     a previous key is set (previous); never the key
  hopper master-key rotate                           a new master key: every secret sealed again under it in one transaction,
                                                     the running hopper on it; prints the new key once (key) — save it, and
                                                     give it as HOPPER_MASTER_KEY before the next start. The hopper's admin's`;

/**
 * `hopper master-key status`: GET /api/master-key, narrowed to the source, the fingerprint and `previous` (and `problem`,
 * when missing). `hopper master-key rotate`: POST /ui/api/master-key `rotate`, narrowed to the new key, its fingerprint and
 * the counts.
 */
export function masterKeyCall(args: string[]): Call {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length === 1 && positionals[0] === 'rotate') {
    return {
      role: 'admin', path: '/ui/api/master-key', body: async () => ({ action: 'rotate' }),
      pick: (v) => {
        const { key, fingerprint, resealed, unreadable } = v as MasterKeyRotated;
        return { key, fingerprint, resealed, unreadable, next: 'save the key in a password manager now, then give it as HOPPER_MASTER_KEY before the next start: a start with the old key is refused' };
      },
    };
  }
  if (positionals.length !== 1 || positionals[0] !== 'status') throw usage('master-key status | hopper master-key rotate');
  return {
    role: 'viewer', path: '/api/master-key',
    pick: (v) => {
      const { source, fingerprint, previous, problem } = v as MasterKeyView;
      return { source, ...(fingerprint === undefined ? {} : { fingerprint }), previous, ...(problem === undefined ? {} : { problem }) };
    },
  };
}

const TYPESAFE_KEY_SET = 'typesafe-key set (the key on stdin, never as an argument)';

/** The key comes from stdin only: an argument would be in the shell's history and the process list. */
export function typesafeKeyCall(args: string[], stdin: () => string): Call {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const [verb, ...extra] = positionals;
  if (verb === undefined) return { role: 'viewer', path: '/api/minor-decisions', pick: (v) => (v as { typesafeKey: unknown }).typesafeKey };
  if (verb === 'remove' && extra.length === 0) return { role: 'operator', path: '/ui/api/typesafe-key', body: async () => ({ action: 'remove' }) };
  if (verb !== 'set' || extra.length > 0) throw usage(verb === 'set' ? TYPESAFE_KEY_SET : `typesafe-key | hopper ${TYPESAFE_KEY_SET} | hopper typesafe-key remove`);
  const value = stdin().trim();
  if (!value) throw new OperatorRefusal('no key on stdin: pipe it in, e.g. hopper typesafe-key set < key-file');
  return { role: 'operator', path: '/ui/api/typesafe-key', body: async () => ({ action: 'set', value }) };
}

export const TOKEN_USAGE = `  hopper token mint --label <who uses it> [--role viewer|operator|admin] [--minutes <1-60>] [--box]
                                                     mint an API token for an agent: printed once; it ends at the next restart or
                                                     sign-in change, as the CLI's own session does; --box: a box token, the only
                                                     kind that may do a box action (start a job, run a command, merge, update)
  hopper token list                                  the user's live API tokens: id, label, role, when each ends; never a token
  hopper token revoke <id>                           end one`;

const TOKEN_MINT = 'token mint --label <who uses it> [--role viewer|operator|admin] [--minutes <1-60>] [--box]';

/** `hopper token mint|list|revoke`: `POST /ui/api/api-tokens` and `GET /api/api-tokens`, under a session of the role minted (admin by default). */
export function tokenCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { label: { type: 'string' }, role: { type: 'string' }, minutes: { type: 'string' }, box: { type: 'boolean' } } });
  const [verb, ...rest] = positionals;
  const flags = Object.keys(values).length > 0;
  if (verb === 'list' && rest.length === 0 && !flags) return { role: 'viewer', path: '/api/api-tokens' };
  if (verb === 'revoke' && rest.length === 1 && !flags) return { role: 'viewer', path: '/ui/api/api-tokens', body: async () => ({ action: 'revoke', id: rest[0] }) };
  if (verb !== 'mint' || rest.length > 0) throw usage(`${TOKEN_MINT} | hopper token list | hopper token revoke <id>`);
  if (!values.label?.trim()) throw usage(TOKEN_MINT);
  if (values.role !== undefined && !(UI_ROLES as readonly string[]).includes(values.role)) throw new OperatorRefusal(`--role ${values.role}: one of ${UI_ROLES.join(', ')}`);
  const minutes = values.minutes === undefined ? undefined : Number(values.minutes);
  if (minutes !== undefined && !Number.isInteger(minutes)) throw new OperatorRefusal(`--minutes ${values.minutes}: a whole number of minutes`);
  const role = (values.role ?? 'admin') as UiRole;
  return { role, path: '/ui/api/api-tokens', body: async () => ({ action: 'mint', label: values.label, role, ...(minutes === undefined ? {} : { minutes }), ...(values.box ? { box: true } : {}) }) };
}
