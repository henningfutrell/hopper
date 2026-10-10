// The keys from the command line. The TypeSafe API key (issue #657): read from stdin, never an argument. The master key's
// status (issue #685, design.md "The master key"): where the running daemon's key came from, its fingerprint, and whether a
// previous key is set. Never the key: the log, the API and the CLI never carry it.
import { parseArgs } from 'node:util';
import type { MasterKeyView } from './domain/types.ts';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const MASTER_KEY_USAGE = `  hopper master-key status                           the master key: where it came from (source), its fingerprint, and whether
                                                     a previous key is set (previous); never the key`;

/** `hopper master-key status`: GET /api/master-key, narrowed to the source, the fingerprint and `previous` (and `problem`, when missing). */
export function masterKeyCall(args: string[]): Call {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length !== 1 || positionals[0] !== 'status') throw usage('master-key status');
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
