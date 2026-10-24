// The keys from the command line. The TypeSafe API key (issue #657): read from stdin, never an argument. The master key's
// status (issue #685, design.md "The master key"): where the running daemon's key came from, its fingerprint, and whether a
// previous key is set; never the key. Its rotation (issue #659, "Rotating the master key"): the one answer that carries a
// key — the new one, once, to stdout, never to the log. Grants (issue #881, design.md "Grants and refresh tokens"): mint one
// for an agent — box tokens with --box (issue #795) —, list them, revoke one or all; its tokens are printed once, by the mint.
import { parseArgs } from 'node:util';
import { UI_ROLES, type MasterKeyRotated, type MasterKeyView, type UiRole } from './domain/types.ts';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const MASTER_KEY_USAGE = `  hopper master-key status                           the master key: where it came from (source), its fingerprint, whether
                                                     a previous key is set (previous), and how the host seals it (sealed);
                                                     never the key
  hopper master-key rotate [--host-seals]            a new master key: every secret sealed again under it in one transaction,
                                                     the running hopper on it; prints the new key once (key) — save it, and
                                                     give it as HOPPER_MASTER_KEY before the next start. The hopper's admin's.
                                                     --host-seals: the caller seals the new key to the host now (master-key.sh
                                                     rotate does); a key the host sealed rotates only so
  hopper master-key script                           print the host's master-key script (scripts/master-key.sh): it seals
                                                     the key to this host and unseals it at launch. No daemon needed`;

/**
 * `hopper master-key status`: GET /api/master-key, narrowed to the source, the fingerprint, `previous` and `sealed`.
 * `hopper master-key rotate`: POST /ui/api/master-key `rotate`, narrowed to the new key, its fingerprint and the counts.
 * (`hopper master-key script` needs no daemon: src/cli.ts.)
 */
export function masterKeyCall(args: string[]): Call {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { 'host-seals': { type: 'boolean' } } });
  if (positionals.length === 1 && positionals[0] === 'rotate') {
    const hostSeals = values['host-seals'] === true;
    return {
      role: 'admin', path: '/ui/api/master-key', body: async () => ({ action: 'rotate', ...(hostSeals ? { hostSeals } : {}) }),
      pick: (v) => {
        const { key, fingerprint, resealed, unreadable } = v as MasterKeyRotated;
        return { key, fingerprint, resealed, unreadable, next: 'save the key in a password manager now, then give it as HOPPER_MASTER_KEY before the next start: a start with the old key is refused' };
      },
    };
  }
  if (positionals.length !== 1 || positionals[0] !== 'status' || values['host-seals']) throw usage('master-key status | hopper master-key rotate [--host-seals] | hopper master-key script');
  return {
    role: 'viewer', path: '/api/master-key',
    pick: (v) => {
      const { source, fingerprint, previous, sealed } = v as MasterKeyView;
      return { source, fingerprint, previous, ...(sealed === undefined ? {} : { sealed }) };
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

export const TOKEN_USAGE = `  hopper token mint --label <who uses it> (--preset <id> | --scope <scope>) [--scope <scope> ...] [--holder <who keeps it>]
                    [--role viewer|operator|admin] [--days <1-365> | --no-expiry] [--minutes <5-15>] [--box] [--deny <name>]... [--jkt=<thumbprint>]
                    [--repo <owner/name>]... [--source <name>]...
                                                     mint a grant for an agent (issue #881): its refresh token and first access
                                                     token printed once. The agent trades the refresh token at
                                                     POST /ui/auth/token/refresh, each time for a new one. --scope: <area>:<act>,
                                                     <area>:*, *:<act> or *; --preset: a preset's scopes, and its box flag
                                                     unless --box (hopper token scopes names both); --no-expiry: an
                                                     admin's grant with no fixed end; --box: its tokens may do a box action
                                                     (start a job, run a command, merge, update); --preset delegate-approver
                                                     with --deny prod: a delegate approver that never approves prod (issue #1138);
                                                     --jkt=: bind it to the agent's key, its JWK SHA-256 thumbprint,
                                                     after = (a thumbprint can start with -): each refresh
                                                     and each use then needs a DPoP proof of that key (issue #892);
                                                     --repo, --source: limit what its tokens act on to the jobs, questions,
                                                     pull requests and items of these repositories and job sources (issue #892)
  hopper token scopes                                every scope a grant may hold, by area, with what it does, and the presets
  hopper token list                                  the user's live grants and exchanged API tokens, and the scopes there are;
                                                     never a token
  hopper token revoke <id>                           end one grant or API token, and every API token of it
  hopper token revoke-all                            end every grant and API token of the user
  hopper token device <code>                         the device grant request an agent shows this user code for (issue #892):
                                                     the grant it asks for, and who asked
  hopper token approve <code> [--role viewer|operator|admin]
                                                     approve it: the grant it asks for, minted for you when its agent polls
                                                     next; its role at most --role (admin by default)
  hopper token deny <code>                           deny it: its agent is told`;

const TOKEN_MINT = 'token mint --label <who uses it> (--preset <id> | --scope <scope>) [--scope <scope> ...] [--holder <who keeps it>] [--role viewer|operator|admin] [--days <1-365> | --no-expiry] [--minutes <5-15>] [--box] [--deny <name>]... [--jkt=<thumbprint>] [--repo <owner/name>]... [--source <name>]...';

const whole = (flag: string, v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new OperatorRefusal(`--${flag} ${v}: a whole number`);
  return n;
};

/** `hopper token mint|list|revoke|revoke-all|device|approve|deny`: `POST /ui/api/api-tokens` and `GET /api/api-tokens`, under a session of the role minted (admin by default). */
export function tokenCall(args: string[]): Call {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { label: { type: 'string' }, holder: { type: 'string' }, scope: { type: 'string', multiple: true }, preset: { type: 'string' }, role: { type: 'string' }, days: { type: 'string' }, 'no-expiry': { type: 'boolean' }, minutes: { type: 'string' }, box: { type: 'boolean' }, deny: { type: 'string', multiple: true }, jkt: { type: 'string' }, repo: { type: 'string', multiple: true }, source: { type: 'string', multiple: true } },
  });
  const [verb, ...rest] = positionals;
  const flags = Object.keys(values).length > 0;
  if (verb === 'list' && rest.length === 0 && !flags) return { role: 'viewer', path: '/api/api-tokens' };
  if (verb === 'scopes' && rest.length === 0 && !flags) return { role: 'viewer', path: '/api/scopes' };
  if (verb === 'revoke' && rest.length === 1 && !flags) return { role: 'viewer', path: '/ui/api/api-tokens', body: async () => ({ action: 'revoke', id: rest[0] }) };
  if (verb === 'revoke-all' && rest.length === 0 && !flags) return { role: 'viewer', path: '/ui/api/api-tokens', body: async () => ({ action: 'revoke-all' }) };
  if (verb === 'device' && rest.length === 1 && !flags) return { role: 'viewer', path: `/api/api-tokens/device/${encodeURIComponent(rest[0]!)}` };
  if (verb === 'deny' && rest.length === 1 && !flags) return { role: 'viewer', path: '/ui/api/api-tokens', body: async () => ({ action: 'deny-device', code: rest[0] }) };
  if (verb === 'approve' && rest.length === 1 && Object.keys(values).every((k) => k === 'role')) {
    if (values.role !== undefined && !(UI_ROLES as readonly string[]).includes(values.role)) throw new OperatorRefusal(`--role ${values.role}: one of ${UI_ROLES.join(', ')}`);
    return { role: (values.role ?? 'admin') as UiRole, path: '/ui/api/api-tokens', body: async () => ({ action: 'approve-device', code: rest[0] }) };
  }
  if (verb !== 'mint' || rest.length > 0) throw usage(`${TOKEN_MINT} | hopper token list | hopper token scopes | hopper token revoke <id> | hopper token revoke-all | hopper token device|approve|deny <code>`);
  if (!values.label?.trim() || (!values.scope?.length && !values.preset)) throw usage(TOKEN_MINT);
  if (values.role !== undefined && !(UI_ROLES as readonly string[]).includes(values.role)) throw new OperatorRefusal(`--role ${values.role}: one of ${UI_ROLES.join(', ')}`);
  if (values.days !== undefined && values['no-expiry']) throw new OperatorRefusal('--days and --no-expiry: name one');
  const minutes = whole('minutes', values.minutes);
  const days = values['no-expiry'] ? null : whole('days', values.days);
  const role = (values.role ?? 'admin') as UiRole;
  return {
    role, path: '/ui/api/api-tokens',
    body: async () => ({
      action: 'mint', label: values.label, ...(values.scope?.length ? { scopes: values.scope } : {}), ...(values.preset ? { preset: values.preset } : {}), role, ...(values.holder === undefined ? {} : { holder: values.holder }),
      ...(days === undefined ? {} : { days }), ...(minutes === undefined ? {} : { minutes }), ...(values.box ? { box: true } : {}),
      ...(values.deny ? { deny: values.deny } : {}), ...(values.jkt === undefined ? {} : { jkt: values.jkt }),
      ...(values.repo?.length || values.source?.length ? { limits: { ...(values.repo?.length ? { repos: values.repo } : {}), ...(values.source?.length ? { sources: values.source } : {}) } } : {}),
    }),
  };
}
