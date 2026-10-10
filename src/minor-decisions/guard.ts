// Never for consequential actions (issue #550): a decider call that deletes, sends, publishes, pays, changes
// permissions or touches a machine the blast-radius gate keeps (issue #542) is never applied, whatever Jev says: it
// goes on as before. The question pipeline's risk rules, plus permissions, which they do not name. Pure.
import type { GuardHit } from '../domain/types.ts';
import { RISK_RULES, riskRules } from '../questions/risk.ts';

const GATED = 'gated machine ';
const PERMISSIONS = /\b(permissions?|chmod|chown|grant|revoke|access (to|for)|admin rights|sudo|role (to|for))\b/i;

/** What makes these texts consequential, by name; empty: nothing. */
export function consequentialOf(texts: readonly string[], o: { gatedMachine?: string } = {}): string[] {
  const text = texts.join('\n');
  return [
    ...riskRules(text),
    ...(PERMISSIONS.test(text) ? ['permissions'] : []),
    ...(o.gatedMachine ? [`${GATED}${o.gatedMachine}`] : []),
  ];
}

/** A risk rule's or the guard's hit by name, with what it catches (issue #679): what a person is told held an answer back. */
export function guardHit(name: string): GuardHit {
  const rule = RISK_RULES.find((r) => r.name === name);
  if (rule) return { name, describe: rule.describe };
  if (name === 'permissions') return { name, describe: 'changing permissions, access or roles' };
  if (name.startsWith(GATED)) return { name, describe: `work on ${name.slice(GATED.length)}, a machine the blast-radius gate keeps` };
  return { name, describe: name };
}
