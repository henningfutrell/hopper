import { describe, expect, it } from 'vitest';
import { riskRules } from '../../src/questions/index.ts';

describe('riskRules', () => {
  const hits: Array<[string, string]> = [
    ['force-push to main', 'force-push'],
    ['git push --force origin x', 'force-push'],
    ['git reset --hard HEAD~3', 'force-push'],
    ['delete the production database', 'delete'],
    ['rm -rf build', 'delete'],
    ['DROP TABLE users', 'delete'],
    ['deploy it now', 'deploy'],
    ['release to prod', 'deploy'],
    ['buy more credits', 'spend'],
    ['charge the card', 'spend'],
    ['use the api key', 'credentials'],
    ['API_KEY is missing', 'credentials'],
    ['paste the password', 'credentials'],
    ['send an email to the customer', 'send-message'],
    ['post to slack', 'send-message'],
    ['notify the team', 'send-message'],
  ];
  it.each(hits)('matches %s as %s', (text, rule) => {
    expect(riskRules(text)).toContain(rule);
  });

  const misses = [
    'fix the tokenizer',
    'add a deleted_at column',
    'write the release notes',
    'which framework should I use?',
    'the emailer module needs a refactor',
    'Use vitest for the tests',
  ];
  it.each(misses)('does not match %s', (text) => {
    expect(riskRules(text)).toEqual([]);
  });

  // Issue #679: a plain negation of what a rule catches is not a hit, in the question or the answer.
  const negated = [
    'This change uses no secrets.',
    'It needs no secrets at all',
    'Go ahead: the step runs without credentials',
    'It runs without any credentials',
    'a secret-free build',
    'The job uses no tokens',
    'It uses no API keys and no passwords',
    'no stored secrets are read',
  ];
  it.each(negated)('does not match the negation %s', (text) => {
    expect(riskRules(text)).toEqual([]);
  });

  const stillHits: Array<[string, string]> = [
    ['rotate the secrets', 'credentials'],
    ['No, paste the password', 'credentials'],
    ['there is no need to rotate the api key', 'credentials'],
    ['no reason to keep it, delete the branch', 'delete'],
    ['It uses no secrets but reads the access token', 'credentials'],
    ['no secrets here; paste the password', 'credentials'],
  ];
  it.each(stillHits)('still matches %s as %s', (text, rule) => {
    expect(riskRules(text)).toContain(rule);
  });

  it('returns each rule name once, in rule order', () => {
    expect(riskRules('deploy and delete and deploy; delete')).toEqual(['delete', 'deploy']);
  });
});
