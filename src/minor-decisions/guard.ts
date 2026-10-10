// Never for consequential actions (issue #550): a decider call that deletes, sends, publishes, pays, changes
// permissions or touches a machine the blast-radius gate keeps (issue #542) is never applied, whatever Jev says: it
// goes on as before. The question pipeline's risk rules, plus permissions, which they do not name. Pure.
import { riskRules } from '../questions/risk.ts';

const PERMISSIONS = /\b(permissions?|chmod|chown|grant|revoke|access (to|for)|admin rights|sudo|role (to|for))\b/i;

/** What makes these texts consequential, by name; empty: nothing. */
export function consequentialOf(texts: readonly string[], o: { gatedMachine?: string } = {}): string[] {
  const text = texts.join('\n');
  return [
    ...riskRules(text),
    ...(PERMISSIONS.test(text) ? ['permissions'] : []),
    ...(o.gatedMachine ? [`gated machine ${o.gatedMachine}`] : []),
  ];
}
