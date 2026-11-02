// The limit prompts (issue #2897): one table of what an agent CLI shows when its account is at a usage, rate or access
// limit, each family with its cases and near misses that must not match, and the reset time a prompt names.
import { describe, expect, it } from 'vitest';
import { limitFailure, limitPromptIn, limitPromptOfFailure, limitResetOf, LIMIT_PROMPTS } from '../../src/domain/limit-prompts.ts';

const NOW = new Date('2026-10-30T10:00:00.000Z');

describe('limitPromptIn', () => {
  it.each([
    ['usage', "You've hit your limit · resets 3pm (UTC)"],
    ['usage', '  ⎿  You have reached your usage limit.'],
    ['usage', '● Claude usage limit reached. Your limit will reset at 7pm'],
    ['usage', 'Claude AI usage limit reached|1793361600'],
    ['usage', 'Weekly limit reached ∙ resets Nov 3, 5pm'],
    ['usage', 'Please upgrade your plan to continue'],
    ['usage', 'You exceeded your current quota, please check your plan and billing details.'],
    ['usage', 'Credit balance is too low'],
    ['rate', 'API Error: Rate limit reached'],
    ['rate', "You're being rate limited. Try again in 5 minutes."],
    ['access', 'Run /extra-usage to continue, or ask your admin to enable access'],
    ["access", "You don't have access to Claude Code"],
    ['access', 'You do not have access to this model.'],
    ['access', 'Fable is not enabled for your organization.'],
  ])('%s: %s', (family, line) => {
    expect(limitPromptIn(['some work', line])).toMatchObject({ family, prompt: line.replace(/^[\s●⎿]+/, '') });
  });

  it.each([
    'Approaching usage limit · resets at 7pm',
    "You've used 91% of your session limit · resets 3pm",
    'I added a test for the usage limit reached message.',
    'The rate limit is 20 requests per hour.',
    "You don't have access to this repository.",
    'You do not have access to the file /etc/shadow.',
    'Ask your admin about it.',
    'upgrade your plan',
    'Done: the limit reached test passes, and the upgrade your plan line is covered.',
  ])('near miss: %s', (line) => {
    expect(limitPromptIn(['some work', line])).toBeUndefined();
  });

  it('reads only the last lines: a prompt with more work after it is not a limit', () => {
    expect(limitPromptIn(["You've hit your limit", 'a', 'b', 'c', 'd', 'e'])).toBeUndefined();
  });

  it('a normal idle screen is no limit', () => {
    expect(limitPromptIn(['● Bash(npm test)', '  ⎿  12 passed', '● All tests pass. I go on with the docs.', ''])).toBeUndefined();
  });

  it('the table is one list: every family has a matcher', () => {
    expect(new Set(LIMIT_PROMPTS.map((p) => p.family))).toEqual(new Set(['usage', 'rate', 'access']));
  });
});

describe('the failure text', () => {
  it('names the limit and the prompt, and gives the prompt back', () => {
    const text = limitFailure({ family: 'access', prompt: 'Run /extra-usage or ask your admin to enable access' });
    expect(text).toBe('usage or access limit (access): the agent stopped at: Run /extra-usage or ask your admin to enable access');
    expect(limitPromptOfFailure(text)).toEqual({ family: 'access', prompt: 'Run /extra-usage or ask your admin to enable access' });
  });

  it('any other failure text has no prompt', () => {
    expect(limitPromptOfFailure("HOPPER_FAILED You've hit your limit")).toBeUndefined();
  });
});

describe('limitResetOf', () => {
  it.each([
    ['resets 3pm (UTC)', '2026-10-30T15:00:00.000Z'],
    ['resets 9am (UTC)', '2026-10-31T09:00:00.000Z'],
    ['resets at 3:30pm (UTC)', '2026-10-30T15:30:00.000Z'],
    ['resets 15:00 (UTC)', '2026-10-30T15:00:00.000Z'],
    ['resets 3pm (America/New_York)', '2026-10-30T19:00:00.000Z'],
    ['resets Nov 3, 5pm (UTC)', '2026-11-03T17:00:00.000Z'],
    ['resets Nov 3 at 5pm (America/New_York)', '2026-11-03T22:00:00.000Z'],
    ['try again in 2 hours', '2026-10-30T12:00:00.000Z'],
    ['try again in 30 minutes', '2026-10-30T10:30:00.000Z'],
    ['resets in 1h 30m', '2026-10-30T11:30:00.000Z'],
    ['resets at 2026-10-30T18:00:00Z', '2026-10-30T18:00:00.000Z'],
    ['Claude AI usage limit reached|1793361600', '2026-10-30T12:00:00.000Z'],
  ])('%s', (text, at) => {
    expect(limitResetOf(text, NOW)).toBe(at);
  });

  it.each([
    'resets 3pm',
    'resets 3pm (Not/AZone)',
    'ask your admin to enable access',
    'resets at 2020-01-01T00:00:00Z',
  ])('no reset time it can trust: %s', (text) => {
    expect(limitResetOf(text, NOW)).toBeUndefined();
  });
});
