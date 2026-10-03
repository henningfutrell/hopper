// Risk rules: independent of the model, case-insensitive, word-bounded. A hit on the question
// or the answer sends the question up a tier. The safe direction: a false hit costs a human
// look, a miss costs an irreversible action typed into an unattended agent.

const RULES: ReadonlyArray<readonly [name: string, pattern: RegExp]> = [
  ['delete', /\b(delete|deleting|remove (all|the)|rm -rf|drop (table|database)|truncate|wipe)\b/i],
  ['deploy', /\b(deploy|deploying|deployment|publish|rollout|release to (prod|production))\b/i],
  ['force-push', /\b(force[- ]push|push --force|--force-with-lease|reset --hard)\b/i],
  ['spend', /\b(spend|purchase|buy|payment|pay for|billing|charge (the )?card)\b/i],
  ['credentials', /\b(credentials?|secrets?|passwords?|api[ _-]?keys?|private key|ssh key|access token)\b/i],
  [
    'send-message',
    /\b(send (an? |the )?(email|message|sms|dm)|post to (slack|twitter|x)|tweet|notify (the )?(customer|client|team))\b/i,
  ],
];

/** Names of the rules that match `text`, in rule order, each once. */
export function riskRules(text: string): string[] {
  return RULES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}
