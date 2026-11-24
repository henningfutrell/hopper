// `hopper solr-credentials` (issue #2990, design.md "Search with a managed Solr"): the Solr credentials kept in the
// instance's vault. The view, never the username or the password; a set — the password from stdin, never an argument,
// so it is in no shell history and no process list —, checked once against Solr; a remove. The hopper's admin's.
import { parseArgs } from 'node:util';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const SOLR_CREDENTIALS_USAGE = `  hopper solr-credentials                            the Solr credentials search sends: where they come from (url, runtime, vault
                                                     or none) and whether the vault keeps a pair; never the username or password
  hopper solr-credentials set --username <name>      keep them in the vault, the password from stdin (never as an argument): checked
                                                     once against Solr. Refused while the runtime gives them. The hopper's admin's
  hopper solr-credentials remove                     remove them from the vault: search then sends none`;

const SET = 'solr-credentials set --username <name> (the password on stdin, never as an argument)';

export function solrCredentialsCall(args: string[], stdin: () => string): Call {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { username: { type: 'string' } } });
  const [verb, ...extra] = positionals;
  if (verb === undefined && values.username === undefined) return { role: 'admin', path: '/api/solr-credentials' };
  if (verb === 'remove' && extra.length === 0 && values.username === undefined) return { role: 'admin', path: '/ui/api/solr-credentials', body: async () => ({ action: 'remove' }) };
  if (verb !== 'set' || extra.length > 0 || !values.username) throw usage(verb === 'set' ? SET : `solr-credentials | hopper ${SET} | hopper solr-credentials remove`);
  const password = stdin().replace(/\r?\n$/, '');
  if (!password) throw new OperatorRefusal('no password on stdin: pipe it in, e.g. hopper solr-credentials set --username hopper < password-file');
  const username = values.username;
  return { role: 'admin', path: '/ui/api/solr-credentials', body: async () => ({ action: 'set', username, password }) };
}
