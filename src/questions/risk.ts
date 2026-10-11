// Risk rules: independent of the model, case-insensitive, word-bounded. A hit on the question
// or the answer sends the question up a tier. The safe direction: a false hit costs a human
// look, a miss costs an irreversible action typed into an unattended agent. Code, not
// configuration: the UI lists them (RISK_RULES) and nothing can weaken them.
// A plain negation is not a hit (issue #679): "uses no secrets", "without any credentials", "secret-free". Only "no",
// "without", "zero" or "not any" right before the match, at most two words between and none that turns the negation
// away from it ("no need to rotate the api key" still hits), or "-free" right after it.
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

/** Words between a negation and a match that mean the negation is not about the match. */
const TURNS = 'to|need|needs|problem|reason|doubt|issue|way|matter|longer|other|but|except|than|one';
const NEGATED_BEFORE = new RegExp(`\\b(?:no|without|zero|not any)\\s+(?:(?!(?:${TURNS})\\b)[\\w-]+\\s+){0,2}$`, 'i');
const FREE_AFTER = /^-free\b/i;

/** `pattern` matches `text` at least once where no plain negation covers the match. */
function hitsUnnegated(pattern: RegExp, text: string): boolean {
  for (const m of text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
    const end = m.index + m[0].length;
    if (!NEGATED_BEFORE.test(text.slice(0, m.index)) && !FREE_AFTER.test(text.slice(end))) return true;
  }
  return false;
}

/** Every risk rule by name, with one line saying what it catches. */
export const RISK_RULES: readonly RiskRuleView[] = RULES.map(([name, , describe]) => ({ name, describe }));

/** Names of the rules that match `text` outside a plain negation, in rule order, each once. */
export function riskRules(text: string): string[] {
  return RULES.filter(([, pattern]) => hitsUnnegated(pattern, text)).map(([name]) => name);
}
