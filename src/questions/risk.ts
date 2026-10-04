// Risk rules: independent of the model, case-insensitive, word-bounded. A hit on the question
// or the answer sends the question up a tier. The safe direction: a false hit costs a human
// look, a miss costs an irreversible action typed into an unattended agent. Code, not
// configuration: the UI lists them (RISK_RULES) and nothing can weaken them.
import type { RiskRuleView } from '../domain/types.ts';

const RULES: ReadonlyArray<readonly [name: string, pattern: RegExp, describe: string]> = [
  ['delete', /\b(delete|deleting|remove (all|the)|rm -rf|drop (table|database)|truncate|wipe)\b/i, 'deleting, removing, dropping, truncating or wiping things'],
  ['deploy', /\b(deploy|deploying|deployment|publish|rollout|release to (prod|production))\b/i, 'deploying, publishing, rolling out or releasing to production'],
  ['force-push', /\b(force[- ]push|push --force|--force-with-lease|reset --hard)\b/i, 'force-pushing or hard-resetting git history'],
  ['spend', /\b(spend|purchase|buy|payment|pay for|billing|charge (the )?card)\b/i, 'spending money: purchases, payments, billing'],
  ['credentials', /\b(credentials?|secrets?|passwords?|api[ _-]?keys?|private key|ssh key|access token)\b/i, 'credentials, secrets, passwords, keys or tokens'],
  [
    'send-message',
    /\b(send (an? |the )?(email|message|sms|dm)|post to (slack|twitter|x)|tweet|notify (the )?(customer|client|team))\b/i,
    'sending a message, email or post to people outside',
  ],
];

/** Every risk rule by name, with one line saying what it catches. */
export const RISK_RULES: readonly RiskRuleView[] = RULES.map(([name, , describe]) => ({ name, describe }));

/** Names of the rules that match `text`, in rule order, each once. */
export function riskRules(text: string): string[] {
  return RULES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}
