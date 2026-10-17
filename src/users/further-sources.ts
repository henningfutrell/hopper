// A job source for each further connected account (issue #1448, design.md "More than one GitHub account"): Intake lists the
// issues of each account's job repositories through that account. The source is the configured `github-account` instance of
// the first account, copied, with `account` set to the further key and named for it (`github-account-2`). The hopper adds it
// at each reload of the plugins; it is never written to the plugins config, so removing the account removes its source.
import { furtherAccount, type ConnectedAccountKey, type InstanceSpec } from '../domain/types.ts';

const PLUGIN = 'github-account';

/** The first account's configured instance: one of the plugin that names no account, or the first. */
const firstOf = (configured: readonly InstanceSpec[]): InstanceSpec | undefined => configured.find((s) => s.plugin === PLUGIN && [undefined, 'github'].includes((s.options as { account?: string } | undefined)?.account));

export function furtherAccountSources(configured: readonly InstanceSpec[], keys: readonly ConnectedAccountKey[]): InstanceSpec[] {
  const first = firstOf(configured);
  if (!first) return []; // no GitHub intake configured: none for a further account either
  const names = new Set(configured.map((s) => s.name));
  const taken = new Set(configured.filter((s) => s.plugin === PLUGIN).map((s) => (s.options as { account?: string } | undefined)?.account));
  return keys.filter((k) => furtherAccount(k) && !taken.has(k)).flatMap((key) => {
    const name = `${PLUGIN}-${key.slice(key.lastIndexOf('-') + 1)}`;
    return names.has(name) ? [] : [{ ...first, name, options: { ...first.options, account: key } }];
  });
}
